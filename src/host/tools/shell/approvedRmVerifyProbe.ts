import path from 'node:path';
import { homedir } from 'node:os';
import { parseShellCommand } from '../../security/commandParse';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ApprovedRmGrant');
/** Short on purpose: the check this covers runs right after the delete the user just approved. */
const VERIFY_WINDOW_MS = 5 * 60 * 1000;
const approvedRemovals = new Map<string, Map<string, number>>();

/** Remember the literal files a user-approved rm just got a grant for (in memory, per session). */
export function rememberApprovedRmTargets(sessionId: string | undefined, targets: readonly string[], now = Date.now()): void {
  const bucket = approvedRemovals.get(sessionId ?? '') ?? new Map<string, number>();
  for (const target of targets) bucket.set(path.resolve(target), now + VERIFY_WINDOW_MS);
  approvedRemovals.set(sessionId ?? '', bucket);
}

const READ_ONLY_PROGRAMS = new Set(['test', '[', 'ls', 'stat', 'echo', 'printf', 'true', ':']);
const PATH_PROGRAMS = new Set(['test', '[', 'ls', 'stat']);
const TEST_OPERATORS = new Set(['!', ']', '-e', '-f', '-d', '-s', '-L', '-h', '-r']);

/**
 * True when `command` only checks (test / [ / ls / stat, plus echo/printf of text) files that the
 * user approved for deletion earlier in this session. Loops, redirects to files, expansions and any
 * other path stay on the normal approval path.
 */
export function isApprovedRmVerifyProbe(command: string, workingDirectory: string, sessionId: string | undefined, now = Date.now()): boolean {
  const bucket = approvedRemovals.get(sessionId ?? '');
  if (!bucket) return false;
  for (const [target, expiry] of bucket) if (expiry <= now) bucket.delete(target);
  if (bucket.size === 0) return false;
  const parsed = parseShellCommand(command);
  if (parsed.parsingFailed || parsed.trailingOperator || parsed.uncertain.length > 0
    || parsed.writeTargets.length > 0 || parsed.segments.length === 0) return false;
  let pathOperands = 0;
  for (const segment of parsed.segments) {
    const [program = '', ...args] = segment.words;
    if (!READ_ONLY_PROGRAMS.has(program) || segment.redirects.length > 0 || segment.reads.length > 0) return false;
    if (segment.terminator !== null && ![';', '\n', '&&', '||'].includes(segment.terminator)) return false;
    if (args.some((word) => /[$`*?{}\\]/.test(word.replaceAll('${?}', '')))) return false;
    if (program === 'printf' && args.some((word) => /^-v|%[^%]*n/.test(word))) return false;
    if (!PATH_PROGRAMS.has(program)) continue;
    if (program === '[' && args.at(-1) !== ']') return false;
    for (const word of args) {
      if (program === 'test' || program === '[' ? TEST_OPERATORS.has(word) : /^-[A-Za-z]+$/.test(word)) continue;
      const home = homedir();
      const literal = word === '~' ? home : word.startsWith('~/') ? path.join(home, word.slice(2)) : word;
      if (!bucket.has(path.resolve(workingDirectory, literal))) return false;
      pathOperands += 1;
    }
  }
  if (pathOperands === 0) return false;
  logger.info(`APPROVED_RM_VERIFY_EXEMPTION ${JSON.stringify({ pathOperands, segments: parsed.segments.length })}`);
  return true;
}
