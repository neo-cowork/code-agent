import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import type { MessageMetadata } from '../../shared/contract';
import type { WorkspaceScope } from '../../shared/contract/project';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { isPathWithinRoot } from '../runtime/workspaceScope';
import { isProtectedWritePath } from '../sandbox/sensitivePaths';
import { createLogger } from '../services/infra/logger';
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
        }
      } catch {
        // Path analysis failure cannot mint an authorization.
      }
    }
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

/** Add only this task's folder to an already-required OS write jail. Approval,
 * command policy and sensitive-path denials remain separate authoritative gates. */
export function taskOutputDirectoryForShell(sessionId: string | undefined, mode: PermissionMode, command: string, workspaceScope?: WorkspaceScope): string | undefined {
  const grant = scope.getStore();
  if (!grant || /\$|`|<\(|>\(/u.test(command)) return undefined;
  const parsed = parseShellCommand(command);
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
