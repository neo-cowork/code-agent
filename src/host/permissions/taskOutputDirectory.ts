import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MessageMetadata } from '../../shared/contract';
import type { WorkspaceScope } from '../../shared/contract/project';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { isPathWithinRoot } from '../runtime/workspaceScope';
import { isProtectedWritePath } from '../sandbox/sensitivePaths';
import { createLogger } from '../services/infra/logger';
import { getUserConfigDir } from '../config/configPaths';
import { getPermissionModeManager, type PermissionMode } from './modes';
import { parseShellCommand } from '../security/commandParse';

interface TaskOutputDirectory {
  sessionId: string;
  directory: string;
  requestedDirectory: string;
  active: boolean;
  leases: number;
}

const scope = new AsyncLocalStorage<TaskOutputDirectory | undefined>();
const logger = createLogger('TaskOutputDirectory');
const RECORD_FILE = 'task-output-directories.json';

interface GrantRecord { directory: string; requestedDirectory: string }

/** Host-written, per-session record of the folder the user named. Written only when a
 * grant is minted from the user's own directive; later runs of the SAME session
 * re-validate it. History text is never re-parsed. */
function recordFilePath(): string {
  return path.join(getUserConfigDir(), RECORD_FILE);
}

function readRecords(): Record<string, GrantRecord> {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordFilePath(), 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, GrantRecord> : {};
  } catch {
    return {};
  }
}

function persistGrant(sessionId: string, record: GrantRecord): void {
  try {
    const records = readRecords();
    records[sessionId] = record;
    fs.mkdirSync(path.dirname(recordFilePath()), { recursive: true });
    fs.writeFileSync(recordFilePath(), JSON.stringify(records), 'utf-8');
  } catch (error) {
    logger.warn('Failed to persist task output directory record', error);
  }
}

/** Re-run every mint-time check against the live filesystem; a retargeted symlink or
 * a now-protected path yields no grant. */
function restoreGrant(sessionId: string): TaskOutputDirectory | undefined {
  const record = readRecords()[sessionId];
  if (!record || typeof record.directory !== 'string' || typeof record.requestedDirectory !== 'string') return undefined;
  try {
    if (!path.isAbsolute(record.requestedDirectory) || record.requestedDirectory.split('/').includes('..')) return undefined;
    const directory = resolveCanonicalRunPath(record.requestedDirectory);
    if (directory !== record.directory || directory === path.parse(directory).root || isProtectedWritePath(directory)) return undefined;
    return { sessionId, directory, requestedDirectory: record.requestedDirectory, active: true, leases: 1 };
  } catch {
    return undefined;
  }
}

/** Only an explicit output directive in the new user's own task can grant a folder.
 * Never scan history, attachments, model output, recovery or automated input. Ambiguous
 * prose stays on the existing confirmation path; a path mention alone is not consent. */
export async function withTaskOutputDirectory<T>(input: {
  sessionId: string | null;
  userText: string;
  metadata?: MessageMetadata;
  internal: boolean;
  /** Host-owned auxiliary execution of this same task, not a fresh source of consent. */
  inherit?: boolean;
  /** Unattended (cron / heartbeat) turn: never mints or restores. */
  unattended?: boolean;
}, run: () => Promise<T>): Promise<T> {
  const metadata = input.metadata;
  let grant: TaskOutputDirectory | undefined;
  const inherited = scope.getStore();
  if (input.inherit && inherited?.active && inherited.sessionId === input.sessionId
    && !metadata?.automation && getPermissionModeManager().getModeForSession(input.sessionId) === 'bypassPermissions') {
    grant = inherited;
    grant.leases += 1;
    logger.info('Task output directory inherited by auxiliary run', { sessionId: grant.sessionId });
  }
  if (!grant && input.sessionId && !input.internal && !metadata?.automation && !metadata?.agentTeam
    && !metadata?.channel && !metadata?.telemetryRecovered && !metadata?.runtimeSteer
    && getPermissionModeManager().getModeForSession(input.sessionId) === 'bypassPermissions') {
    // A complete, unquoted directive line with one absolute path. No generic path
    // extraction / model inference, shell expansion, relative path or multiple grants.
    const directives = input.userText.split(/\r?\n/).filter((line) =>
      /(?:^输出目录|(?:^|[，；])成品都存到同一目录)[：:]/u.test(line));
    const raw = directives.length === 1 && !/```|~~~|不要|不得|禁止|勿|\bdo not\b|\bdon't\b/iu.test(input.userText)
      ? directives[0].match(/(?:^输出目录|(?:^|[，；])成品都存到同一目录)[：:]\s*(\/[^\s`'"<>$\\]+)\s*$/u)?.[1]
      : undefined;
    if (raw && path.isAbsolute(raw) && !raw.split('/').includes('..')) {
      try {
        const directory = resolveCanonicalRunPath(raw);
        if (directory !== path.parse(directory).root && !isProtectedWritePath(directory)) {
          grant = { sessionId: input.sessionId, directory, requestedDirectory: path.resolve(raw), active: true, leases: 1 };
          persistGrant(input.sessionId, { directory, requestedDirectory: grant.requestedDirectory });
        }
      } catch {
        // Path analysis failure cannot mint an authorization.
      }
    }
  }
  const manager = getPermissionModeManager();
  if (!grant && input.sessionId && !input.unattended && !manager.isUnattendedSession(input.sessionId)
    && !metadata?.automation && !metadata?.agentTeam && !metadata?.channel
    && manager.getModeForSession(input.sessionId) === 'bypassPermissions') {
    grant = restoreGrant(input.sessionId);
    if (grant) logger.info('Task output directory restored for session', { sessionId: grant.sessionId, directory: grant.directory });
  }
  return scope.run(grant, async () => {
    if (grant) logger.info('Task output directory authorized', { sessionId: grant.sessionId, directory: grant.directory });
    try {
      return await run();
    } finally {
      // Detached children retain this object, so clearing ALS alone is insufficient.
      if (grant && --grant.leases === 0) {
        grant.active = false;
        logger.info('Task output directory expired', { sessionId: grant.sessionId });
      }
    }
  });
}

/** A quoted heredoc body (`<<'PY'`) is never expanded or run by the invoking shell; it is plain
 * stdin for the program (e.g. a python script). Dropping it lets the guard see the real command
 * line. Bodies fed to a shell interpreter or eval are kept, because those do get executed. */
function withoutInertHeredocBodies(command: string): string {
  return command.replace(/<<-?[ \t]*(['"])([A-Za-z_]\w*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/gu,
    (match, _quote: string, _tag: string, rest: string, offset: number) => {
      const lineStart = command.lastIndexOf('\n', offset - 1) + 1;
      return /\b(?:sh|bash|zsh|dash|ksh|eval|source)\b/u.test(command.slice(lineStart, offset)) ? match : rest;
    });
}

/** Add only this task's folder to an already-required OS write jail. Approval,
 * command policy and sensitive-path denials remain separate authoritative gates. */
export function taskOutputDirectoryForShell(sessionId: string | undefined, mode: PermissionMode, command: string, workspaceScope?: WorkspaceScope): string | undefined {
  const grant = scope.getStore();
  // `$?` `$#` `$$` `$!` expand to numbers only, so they cannot name a path; every other
  // expansion form (`$VAR`, `${..}`, `$(..)`, backticks, process substitution) stays rejected.
  const inspected = withoutInertHeredocBodies(command).replace(/\$[?#$!]/gu, '');
  if (!grant || /\$|`|<\(|>\(/u.test(inspected)) return undefined;
  const parsed = parseShellCommand(inspected);
  if (parsed.parsingFailed || parsed.uncertain.length > 0) return undefined;
  // A selected output folder does not override a Project Source's read-only promise,
  // including when the selected folder contains that Source rather than vice versa.
  if (workspaceScope?.roots.some((root) => root.access === 'read_only'
    && (isPathWithinRoot(grant.directory, resolveCanonicalRunPath(root.path))
      || isPathWithinRoot(resolveCanonicalRunPath(root.path), grant.directory)))) return undefined;
  return isTaskOutputPathAuthorized({ sessionId, mode, target: grant.directory, cwd: grant.directory })
    ? grant.directory : undefined;
}

/** Recheck real paths on every use; symlink retargets cannot widen the frozen grant. */
export function isTaskOutputPathAuthorized(input: {
  sessionId?: string;
  mode?: PermissionMode;
  target: string;
  cwd: string;
}): boolean {
  const grant = scope.getStore();
  if (!grant?.active || input.sessionId !== grant.sessionId || input.mode !== 'bypassPermissions') return false;
  try {
    const lexical = path.resolve(input.cwd, input.target);
    const canonical = resolveCanonicalRunPath(lexical);
    return resolveCanonicalRunPath(grant.requestedDirectory) === grant.directory
      && (isPathWithinRoot(lexical, grant.requestedDirectory) || isPathWithinRoot(lexical, grant.directory))
      && isPathWithinRoot(canonical, grant.directory)
      && !isProtectedWritePath(canonical, { projectRoot: grant.directory });
  } catch {
    return false;
  }
}
