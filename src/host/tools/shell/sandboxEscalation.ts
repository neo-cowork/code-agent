import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { OsSandboxDecision, OsSandboxPermissionMode } from '../../sandbox/osSandboxPolicy';
import { resolveCanonicalRunPath } from '../../runtime/runContext';
import { parseShellCommand } from '../../security/commandParse';
import type { PolicyEnforcer } from '../../security/policyEnforcer';
import { denyConcreteShellWritePath } from './writePathPolicyDeny';
import { createLogger } from '../../services/infra/logger';

const approvedRmLogger = createLogger('ApprovedRmGrant');

function expandLeadingHome(rawPath: string): string {
  const home = homedir();
  if (rawPath === '~') return home;
  if (rawPath.startsWith('~/')) return path.join(home, rawPath.slice(2));
  if (rawPath === '$HOME' || rawPath === '${HOME}') return home;
  if (rawPath.startsWith('$HOME/')) return path.join(home, rawPath.slice(6));
  if (rawPath.startsWith('${HOME}/')) return path.join(home, rawPath.slice(8));
  return rawPath;
}

/** Parse only the literal operands covered by one plain rm approval. */
function extractApprovedRmTargets(command: string, workingDirectory: string): {
  targets?: string[];
  operandCount: number;
  reason?: string;
} {
  const parsed = parseShellCommand(command);
  const rmSegments = parsed.segments.filter((segment) => path.posix.basename(segment.words[0] ?? '') === 'rm');
  const operands: string[] = [];
  let dashDash = false;
  let unsupportedOption = false;
  for (const arg of rmSegments[0]?.words.slice(1) ?? []) {
    if (!dashDash && arg === '--') { dashDash = true; continue; }
    if (!dashDash && arg.startsWith('-') && arg !== '-') {
      if (arg !== '-f' && arg !== '--force') unsupportedOption = true;
      continue;
    }
    operands.push(arg);
  }
  const refuse = (reason: string) => ({ operandCount: operands.length, reason });
  if (parsed.parsingFailed || parsed.trailingOperator || parsed.writeTargets.length > 0
    || parsed.uncertain.length > 0 || /[<>]/.test(command) || rmSegments.length !== 1) {
    return refuse('command_shape');
  }
  let seenRm = false;
  for (const current of parsed.segments) {
    if (current.redirects.length > 0 || current.reads.length > 0) return refuse('redirect');
    const program = current.words[0] ?? '';
    if (current === rmSegments[0]) {
      seenRm = true;
    } else {
      if (!['echo', 'printf', 'true', ':'].includes(program)) return refuse('command_shape');
      // Status reporting may expand $?, never assign variables or write through printf.
      if (current.words.slice(1).some((word) => /[$`]/.test(word.replaceAll('${?}', '')))) return refuse('expansion');
      if (program === 'printf' && current.words.slice(1).some((word) => /^-v|%[^%]*n/.test(word))) return refuse('command_shape');
    }
    if (current.terminator !== null && current.terminator !== ';' && current.terminator !== '&&'
      && !(seenRm && current.terminator === '||')) return refuse('command_shape');
  }
  if (unsupportedOption) return refuse('option');
  // Bounded, all-or-nothing: a card must name every file its command can delete.
  if (operands.length < 1 || operands.length > 8) return refuse('operand_count');
  if (operands.some((operand) => !operand || /[$`*?{}[\]]/.test(operand))) return refuse('literal_operand');
  return {
    operandCount: operands.length,
    targets: operands.map((operand) => path.resolve(workingDirectory, expandLeadingHome(operand))),
  };
}

export interface SandboxEscalationEligibilityInput {
  sandboxDecision: Pick<OsSandboxDecision, 'sandboxed'>;
  foreground: boolean;
  pty: boolean;
  background: boolean;
  unattended: boolean;
  writeFence: boolean;
  evalRealRoot: boolean;
  permissionMode: OsSandboxPermissionMode;
  abortSignal: AbortSignal;
  deniedPath?: string;
  /**
   * The denial came from creating a directory. The file gate never offers these;
   * the directory gate requires this flag before it may offer a missing path.
   */
  deniedPathCreatesDirectory?: boolean;
  /**
   * The sandbox can allow one path that does not exist yet (seatbelt literal /
   * subpath; bubblewrap cannot bind a missing path). Gates missing files and
   * missing directories alike.
   */
  newFileGrantSupported: boolean;
  /** Command cwd. User path rules compare workspace-relative spellings against it. */
  workingDirectory: string;
  /**
   * The enforcer ToolExecutor bound for this call (null = no policy file). Never the
   * process singleton: by the time the first run is denied, another workspace may
   * have rebound it. undefined = nobody bound one = hard deny.
   */
  policyEnforcer: PolicyEnforcer | null | undefined;
}

type EscalationTarget = 'file' | 'missing' | 'other';

/**
 * The card grants exactly one file, never a tree: the retry gets a literal
 * write allowance for this path and nothing below it. A directory (existing or
 * about to be created) would need a subtree grant whose descendants no card can
 * list, so directories, symlinks and special files are never offered. A missing
 * file needs an existing parent directory, otherwise the retry cannot create it.
 * The offered path is canonical (symlinks in parent directories resolved): the
 * card shows and the retry grants the file that is actually written, never a
 * workspace-looking spelling of a file outside it.
 */
function escalationTarget(resolvedPath: string): EscalationTarget {
  try {
    return fs.lstatSync(resolvedPath).isFile() ? 'file' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'other';
  }
  try {
    return fs.statSync(path.dirname(resolvedPath)).isDirectory() ? 'missing' : 'other';
  } catch {
    return 'other';
  }
}

type DirectoryEscalationTarget = 'directory' | 'missing-directory' | 'other';

/**
 * The card grants one directory subtree: the retry may write this directory and
 * everything created below it. The granted root is exactly the denied path
 * (canonical), never an ancestor. lstat refuses a symlink as the last
 * component, so a denied symlink spelling is only offered after canonical
 * resolution lands on the real directory. A missing path needs an existing
 * parent plus a mkdir denial and a sandbox that can grant paths that do not
 * exist yet (D3 trial: seatbelt subpath allows creation; bubblewrap cannot).
 */
function directoryEscalationTarget(resolvedPath: string): DirectoryEscalationTarget {
  try {
    return fs.lstatSync(resolvedPath).isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'other';
  }
  try {
    return fs.statSync(path.dirname(resolvedPath)).isDirectory() ? 'missing-directory' : 'other';
  } catch {
    return 'other';
  }
}

/**
 * Coarser granularity means coarser red lines (design doc, 边界三): `/`, home
 * itself, every ancestor of home (their subtrees contain home) and every direct
 * child of home (`~/.ssh`, `~/Library`, the data dirs) never open a card.
 */
function directoryEscalationRefused(candidate: string, home: string): boolean {
  if (candidate === path.parse(candidate).root) return true;
  if (candidate === home || home.startsWith(`${candidate}${path.sep}`)) return true;
  return path.dirname(candidate) === home;
}

function writePathPolicyBlocksEscalation(
  deniedPath: string,
  resolvedPath: string,
  workingDirectory: string,
  policyEnforcer: PolicyEnforcer | null,
): boolean {
  try {
    return denyConcreteShellWritePath({
      resolvedPath,
      workingDirectory,
      policyEnforcer,
      pathCandidates: [deniedPath, resolvedPath],
      displayPath: deniedPath,
    }) !== undefined;
  } catch {
    // Unclassifiable paths stay hard-denied. A card would add them to the write grant.
    return true;
  }
}

/** Return the one file that may be offered for a single foreground retry. */
export function shouldOfferEscalation(input: SandboxEscalationEligibilityInput): string | undefined {
  const deniedPath = input.deniedPath;
  if (
    !input.sandboxDecision.sandboxed
    || !input.foreground
    || input.pty
    || input.background
    || input.unattended
    || input.writeFence
    || input.evalRealRoot
    || (input.permissionMode !== 'default' && input.permissionMode !== 'acceptEdits')
    || input.abortSignal.aborted
    || !deniedPath
    || !path.isAbsolute(deniedPath)
  ) {
    return undefined;
  }

  return resolveEscalationFile(input);
}

/** Shared path/policy checks; callers separately enforce their consent and execution gates. */
function resolveEscalationFile(input: SandboxEscalationEligibilityInput): string | undefined {
  const deniedPath = input.deniedPath;
  if (!deniedPath || !path.isAbsolute(deniedPath)) return undefined;
  const home = path.resolve(homedir());
  const spelledPath = path.resolve(deniedPath);
  // lstat on the spelled path refuses a symlink as the last component; the canonical path would hide it.
  if (spelledPath === path.parse(spelledPath).root || spelledPath === home || escalationTarget(spelledPath) === 'other') {
    return undefined;
  }
  let resolvedPath: string;
  try {
    resolvedPath = resolveCanonicalRunPath(spelledPath);
  } catch {
    return undefined;
  }
  if (resolvedPath === path.parse(resolvedPath).root || resolvedPath === home) return undefined;
  const target = escalationTarget(resolvedPath);
  if (target === 'other') return undefined;
  if (target === 'missing' && (input.deniedPathCreatesDirectory === true || !input.newFileGrantSupported)) {
    return undefined;
  }
  if (input.policyEnforcer === undefined) return undefined;
  if (writePathPolicyBlocksEscalation(deniedPath, resolvedPath, input.workingDirectory, input.policyEnforcer)) {
    return undefined;
  }
  return resolvedPath;
}

/** Mint literal write paths for all files covered by one user-approved rm. */
export function approvedSingleFileRmGrant(
  command: string,
  input: Omit<SandboxEscalationEligibilityInput, 'deniedPath' | 'deniedPathCreatesDirectory'>,
): string | string[] | undefined {
  const parsed = extractApprovedRmTargets(command, input.workingDirectory);
  const conditions = [
    !input.sandboxDecision.sandboxed && 'sandboxed',
    !input.foreground && !input.background && 'foreground', input.pty && 'pty',
    input.unattended && 'unattended', input.writeFence && 'write_fence', input.evalRealRoot && 'eval_real_root',
    !['default', 'acceptEdits'].includes(input.permissionMode) && 'mode',
    input.abortSignal.aborted && 'aborted', parsed.reason,
  ].filter((condition): condition is string => typeof condition === 'string');
  const grants: string[] = [];
  if (conditions.length === 0 && parsed.targets) {
    for (const [operandIndex, deniedPath] of parsed.targets.entries()) {
      if (escalationTarget(deniedPath) !== 'file') {
        conditions.push(`path_class:operand_${operandIndex + 1}`);
        break;
      }
      // A user-approved literal rm may run asynchronously in an attended session.
      // This does not offer background escalation cards or relax unattended/write fences.
      const granted = resolveEscalationFile({ ...input, deniedPath, deniedPathCreatesDirectory: false });
      if (!granted) {
        conditions.push(`${input.policyEnforcer === undefined ? 'policy_unbound' : 'path_policy'}:operand_${operandIndex + 1}`);
        break;
      }
      grants.push(granted);
    }
  }
  const diagnostic = { sandboxed: input.sandboxDecision.sandboxed, foreground: input.foreground,
    pty: input.pty, background: input.background, unattended: input.unattended, writeFence: input.writeFence,
    mode: input.permissionMode, operandCount: parsed.operandCount, conditions };
  if (conditions.length > 0 || grants.length === 0) {
    approvedRmLogger.warn(`APPROVED_RM_GRANT_REFUSED ${JSON.stringify(diagnostic)}`);
    return undefined;
  }
  approvedRmLogger.info(`APPROVED_RM_GRANT_MINTED ${JSON.stringify(diagnostic)}`);
  return grants.length === 1 ? grants[0] : grants;
}

/** Return the one directory subtree that may be offered for a single foreground retry. */
export function shouldOfferDirectoryEscalation(input: SandboxEscalationEligibilityInput): string | undefined {
  const deniedPath = input.deniedPath;
  if (
    !input.sandboxDecision.sandboxed
    || !input.foreground
    || input.pty
    || input.background
    || input.unattended
    || input.writeFence
    || input.evalRealRoot
    || (input.permissionMode !== 'default' && input.permissionMode !== 'acceptEdits')
    || input.abortSignal.aborted
    || !deniedPath
    || !path.isAbsolute(deniedPath)
  ) {
    return undefined;
  }

  const home = path.resolve(homedir());
  const spelledPath = path.resolve(deniedPath);
  // lstat on the spelled path refuses a symlink as the last component; the canonical path would hide it.
  if (directoryEscalationRefused(spelledPath, home) || directoryEscalationTarget(spelledPath) === 'other') {
    return undefined;
  }
  let resolvedPath: string;
  try {
    resolvedPath = resolveCanonicalRunPath(spelledPath);
  } catch {
    return undefined;
  }
  if (directoryEscalationRefused(resolvedPath, home)) return undefined;
  const target = directoryEscalationTarget(resolvedPath);
  if (target === 'other') return undefined;
  if (target === 'missing-directory'
    && (input.deniedPathCreatesDirectory !== true || !input.newFileGrantSupported)) {
    return undefined;
  }
  if (input.policyEnforcer === undefined) return undefined;
  if (writePathPolicyBlocksEscalation(deniedPath, resolvedPath, input.workingDirectory, input.policyEnforcer)) {
    return undefined;
  }
  return resolvedPath;
}

/**
 * Directory card wording (design doc 卡片文案). The question line is fixed; the
 * forbidden-name exception sentence is appended only when the granted directory
 * already exists — the deny lines / ro-bind covers only names that already exist
 * inside the granted tree, so a directory that does not exist at denial time
 * (mkdir denial) has nothing to protect and its card must not promise the
 * exception (FB-415: the opening is a subset of the promise).
 */
export function directoryEscalationReason(offeredDirectoryPath: string): string {
  const question =
    `沙盒拦截了这一步：它想写入目录 ${offeredDirectoryPath}（含其中全部内容）。允许仅这一次写入这个目录及其中内容并重跑？`;
  return directoryEscalationTarget(offeredDirectoryPath) === 'directory'
    ? `${question}（其中已有的凭据与配置类文件仍不可写）`
    : question;
}

export const SANDBOX_ESCALATION_DECLINED_MESSAGE =
  'The user declined to widen the sandbox for this command. Run it outside the workspace yourself, or ask to change the target path.';

type SandboxEscalationDecision = 'approved' | 'declined';

export interface SandboxEscalationMeta {
  path: string;
  decision: SandboxEscalationDecision;
  /** Card granularity (D4); file cards keep the legacy shape with the field absent. */
  granularity?: 'file' | 'directory';
}
