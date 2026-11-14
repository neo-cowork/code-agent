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

/** Reject shell expansion whose argv cannot be determined without running the shell. */
function hasUnsafeRmExpansion(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === '`' || (character === '$' && command[index + 1] === '(')) return true;
    if (character === '\\' && quote !== "'") {
      if (command[index + 1] === '$' || command[index + 1] === '`') return true;
      index += 1;
      continue;
    }
    if (character === quote) { quote = undefined; continue; }
    if (!quote && (character === "'" || character === '"')) { quote = character; continue; }
    // Unquoted variables undergo word splitting and pathname expansion. Status is numeric.
    if (character === '$' && quote !== '"' && !/^\$(?:\?|\{\?\})/.test(command.slice(index))) return true;
  }
  return quote !== undefined;
}

/** Project only the exact descriptor duplication out of the policy parser, never execution. */
function projectApprovedRmRedirects(command: string): { source: string; marker: string; refused: boolean } {
  let marker = '__approved_rm_stderr_dup__';
  while (command.includes(marker)) marker += '_';
  let source = '';
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === '\\' && quote !== "'") {
      source += character + (command[++index] ?? '');
      continue;
    }
    if (character === quote) quote = undefined;
    else if (!quote && (character === "'" || character === '"')) quote = character;
    if (!quote && character === '2' && command.startsWith('2>&1', index)
      && (index === 0 || /[\s;&|]/.test(command[index - 1]))
      && (index + 4 === command.length || /[\s;&|]/.test(command[index + 4]))) {
      source += ` ${marker} `;
      index += 3;
      continue;
    }
    if (!quote && /[<>]/.test(character)) return { source, marker, refused: true };
    source += character;
  }
  return { source, marker, refused: false };
}

/** Parse approved static rm calls and read-only probes without executing their shell syntax. */
function extractApprovedRmTargets(command: string, workingDirectory: string): {
  containsRm: boolean;
  targets?: string[];
  operandCount: number;
  reason?: string;
} {
  const projection = projectApprovedRmRedirects(command);
  const original = parseShellCommand(command);
  const parsed = parseShellCommand(projection.source);
  const redirected = new Set(parsed.segments.filter(segment => segment.words.includes(projection.marker)));
  for (const segment of parsed.segments) segment.words = segment.words.filter(word => word !== projection.marker);
  const rmSegments = parsed.segments.filter((segment) => path.posix.basename(segment.words[0] ?? '') === 'rm');
  const operands: string[] = [];
  const containsRm = rmSegments.length > 0 || original.segments.some(segment => path.posix.basename(segment.words[0] ?? '') === 'rm');
  const refuse = (reason: string) => ({ containsRm, operandCount: operands.length, reason });
  if (projection.refused) return refuse('command_shape:redirect_non_dup');
  if (hasUnsafeRmExpansion(command)) return refuse('expansion');
  if (parsed.writeTargets.length > 0) return refuse('command_shape:filesystem_change');
  if (parsed.parsingFailed || parsed.trailingOperator
    || parsed.uncertain.length > 0 || rmSegments.length < 1) {
    return refuse('command_shape');
  }
  const bindings = new Map<string, string>();
  let seenCommand = false;
  for (const current of parsed.segments) {
    if (current.redirects.length > 0 || current.reads.length > 0) return refuse('command_shape:redirect_non_dup');
    const program = current.words[0] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) {
      // Only unconditional prefix assignments. No command-local env, reassignment, or shell controls.
      if (redirected.has(current)) return refuse('command_shape:redirect_non_dup');
      if (seenCommand || ![';', '\n', null].includes(current.terminator)) return refuse('assignment_position');
      for (const word of current.words) {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([^$`*?{}[\]~]*)$/.exec(word);
        if (!assignment) return refuse('assignment_value');
        const [, name, value] = assignment;
        if (bindings.has(name) || name in process.env
          || /^(?:_|BASH.*|ZSH.*|IFS|ENV|PATH|CDPATH|GLOBIGNORE|FIGNORE|SHELLOPTS|RANDOM|SRANDOM|SECONDS|EPOCH.*|LINENO|PPID|UID|EUID|GROUPS|FUNCNAME|DIRSTACK|PIPESTATUS|OPTIND|OPTARG|PS[0-4]|PROMPT_COMMAND)$/.test(name)) {
          return refuse('assignment_control');
        }
        bindings.set(name, value);
      }
      continue;
    }
    seenCommand = true;
    const substitute = (word: string): string => word.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (reference, name: string) => bindings.get(name) ?? reference,
    );
    if (rmSegments.includes(current)) {
      if (rmSegments.length === 1 && parsed.segments[parsed.segments.indexOf(current) - 1]?.terminator === '||') return refuse('command_shape');
      if (!['rm', '/bin/rm', '/usr/bin/rm'].includes(program)) return refuse('command_shape');
      const segmentOperandStart = operands.length;
      let dashDash = false;
      for (const rawArg of current.words.slice(1)) {
        const arg = substitute(rawArg);
        if (!dashDash && arg === '--') { dashDash = true; continue; }
        if (!dashDash && arg.startsWith('-') && arg !== '-') {
          if (arg !== '-f' && !(rmSegments.length === 1 && arg === '--force')) return refuse('option');
          continue;
        }
        if (!arg || /[$`*?{}[\]]/.test(arg)) return refuse('literal_operand');
        if ((rmSegments.length > 1 || redirected.size > 0) && (!path.isAbsolute(rawArg) || rawArg.includes('$'))) {
          return refuse('command_shape:operand_not_absolute_literal');
        }
        // Bound values are literal strings, not a second opportunity for tilde expansion.
        operands.push(rawArg.includes('$') ? path.resolve(workingDirectory, arg) : expandLeadingHome(arg));
      }
      if (operands.length === segmentOperandStart) return refuse('operand_count');
    } else {
      if (['cd', 'pushd', 'popd'].includes(program)) return refuse('command_shape:multi_rm_cwd_change');
      if (['mv', 'cp', 'ln', 'touch'].includes(program)) return refuse('command_shape:filesystem_change');
      if (!['test', '[', 'ls', 'stat', 'echo', 'printf', 'true', ':'].includes(program)) return refuse('command_shape');
      if (redirected.has(current) && ['true', ':'].includes(program)) return refuse('command_shape:redirect_non_dup');
      if (program === '[' && current.words.at(-1) !== ']') return refuse('command_shape');
      if (current.words.slice(1).some((word) => /[$`]/.test(substitute(word).replaceAll('${?}', '')))) return refuse('expansion');
      if (program === 'printf' && current.words.slice(1).some((word) => /^-v|%[^%]*n/.test(substitute(word)))) return refuse('command_shape');
    }
    if (current.terminator !== null && ![';', '\n', '&&', '||'].includes(current.terminator)) return refuse('command_shape');
  }
  if (operands.length < 1) return refuse('operand_count');
  return {
    containsRm: true,
    operandCount: operands.length,
    targets: operands.map((operand) => path.resolve(workingDirectory, operand)),
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
  if (!parsed.containsRm) return undefined;
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
        conditions.push(`path_class:operand_${operandIndex + 1}:operand_not_regular_file`);
        break;
      }
      // A user-approved literal rm may run asynchronously in an attended session.
      // This does not offer background escalation cards or relax unattended/write fences.
      const granted = resolveEscalationFile({ ...input, deniedPath, deniedPathCreatesDirectory: false });
      if (!granted) {
        conditions.push(`${input.policyEnforcer === undefined ? 'policy_unbound' : 'path_policy'}:operand_${operandIndex + 1}:policy_denied`);
        break;
      }
      if (!grants.includes(granted)) grants.push(granted);
      if (grants.length > 8) { conditions.push('operand_count>8'); break; }
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
  return grants.length === 1 && parsed.operandCount === 1 ? grants[0] : grants;
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
