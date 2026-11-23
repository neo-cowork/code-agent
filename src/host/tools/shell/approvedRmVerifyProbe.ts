import path from 'node:path';
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
 * user approved for deletion earlier in this session. A `for` loop is covered only when every list item is such a file. Redirects to files, expansions and any
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
  // The parser drops quotes, so `~` could be expanded or literal in bash, and `..` can cross a symlink that
  // path.resolve folds away: only plain spellings are compared with the approved files.
  const approved = (word: string) => !word.startsWith('~') && !word.split('/').includes('..')
    && bucket.has(path.resolve(workingDirectory, word));
  // `for f in <approved files>; do if [ -e "$f" ]; ...; fi; done`: the list is only approved files, so "$f" is too.
  const loopVars = new Set<string>();
  for (const segment of parsed.segments) {
    let words = segment.words;
    if (segment.redirects.length > 0 || segment.reads.length > 0) return false;
    if (words[0] === 'for') {
      // The parser folds $p and "$p" together, so an unquoted $p could word-split: loop only over paths that cannot split or glob.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(words[1] ?? '') || words[2] !== 'in' || words.length < 4
        || !words.slice(3).every((word) => approved(word) && !/[\s*?[\]{}\\$`]/.test(word))) return false;
      loopVars.add(words[1]);
      continue;
    }
    if (['do', 'done', 'then', 'else', 'fi'].includes(words[0] ?? '') && words.length === 1) continue;
    while (['if', 'then', 'else', 'do'].includes(words[0] ?? '')) words = words.slice(1);
    const [program = '', ...args] = words;
    if (!READ_ONLY_PROGRAMS.has(program)) return false;
    if (segment.terminator !== null && ![';', '\n', '&&', '||'].includes(segment.terminator)) return false;
    const isLoopVar = (word: string) => loopVars.has(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(word)?.[1] ?? '');
    const plain = (word: string) => word.replaceAll('${?}', '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => loopVars.has(name) ? '' : '$');
    if (args.some((word) => /[$`*?{}\\]/.test(plain(word)))) return false;
    if (program === 'printf' && args.some((word) => /^-v|%[^%]*n/.test(word))) return false;
    if (!PATH_PROGRAMS.has(program)) continue;
    if (program === '[' && args.at(-1) !== ']') return false;
    for (const word of args) {
      if (program === 'test' || program === '[' ? TEST_OPERATORS.has(word) : /^-[A-Za-z]+$/.test(word)) continue;
      if (!isLoopVar(word) && !approved(word)) return false;
      pathOperands += 1;
    }
  }
  if (pathOperands === 0) return false;
  logger.info(`APPROVED_RM_VERIFY_EXEMPTION ${JSON.stringify({ pathOperands, segments: parsed.segments.length })}`);
  return true;
}
