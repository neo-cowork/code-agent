// ============================================================================
// Managed LibreOffice shell hook（ADR-090 §3 row 7 — N-ENV-ASSIST-S5-RUNTIME）
//
// 挂在 createEvalSafeShellEnv 末尾（与托管 Python 同一处，bash 前台/后台/PTY 三条路径共用）。
// 只看「把 soffice / libreoffice 当程序执行」的命令——命令位的词，不是引号里、echo 后面、
// 注释或 heredoc 正文里的文字：
//   托管副本已装、命令里的 soffice / libreoffice 由它来解析 ⇒ 只把托管的 Contents/MacOS 追加到 PATH 末尾
//     （从不前置，PATH 其余部分逐字节不动），并给 LibreOffice 两个在 Bash 沙箱里起得来的环境变量；
//   本机没有 ⇒ 不执行：后台起一次 ensureLibreOffice（单飞），返回 fail-closed 结果。
//     停不停车由 Bash 模块按 run 能不能等来决定（parkMissingRuntime）。
// 不以 soffice / libreoffice 当程序用的命令：环境逐字节不变。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext } from '../../../protocol/tools';
import { pathToFileURL } from 'node:url';
import { LIBREOFFICE_SEARCH_PATHS } from '../../media/ppt/constants';
import { LIBREOFFICE_MANAGED_ONLY_ENV } from '../../../runtime/libreOffice/constants';
import { ensureLibreOffice } from '../../../runtime/libreOffice/ensure';
import { managedLibreOfficePath, resolveLibreOfficeRoot } from '../../../runtime/libreOffice/layout';
import { getLibreOfficeCandidates } from '../../../runtime/libreOffice/lookup';
import { getLibreOfficeState } from '../../../runtime/libreOffice/state';
import type { LibreOfficeRuntimeErrorCode } from '../../../runtime/libreOffice/types';

const LIBREOFFICE_COMMANDS = new Set(['soffice', 'libreoffice']);
/** Words that only wrap the real command: the command position stays open after them (and their options). */
const COMMAND_PREFIXES = new Set(['sudo', 'command', 'exec', 'nohup', 'env', 'builtin', 'nice', 'caffeinate', 'ionice', 'setsid', 'time']);
/** Control keywords after which a command follows. */
const LIST_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', 'function']);
/** Control keywords that end a list: what follows is an operator, not a command. */
const CLOSING_KEYWORDS = new Set(['in', 'fi', 'done', 'esac']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const DIGITS = /^\d+$/;
const WHITESPACE = /\s/;
const BRACE_KEYWORD = /[\s;|&]/;
/** LibreOffice's per-user settings live under the temp directory the Bash sandbox already lets it write. */
const OFFICE_PROFILE_DIRNAME = 'neo-libreoffice-profile';
/** Must match the owner-approved Unix-socket directory in src/host/sandbox/seatbelt.ts (`allowOfficeIpc`). */
const OFFICE_IPC_SOCKET_DIR = '/private/tmp';

export interface ManagedLibreOfficeBlock {
  ok: false;
  code: LibreOfficeRuntimeErrorCode | 'LIBREOFFICE_RUNTIME_INSTALLING';
  /** Plain model-facing guidance, never a system error text. */
  error: string;
  /** The ADR-090 blocker behind the refusal: names the card and, for a run that can wait, the park. */
  envBlocked: { class: 'runtime_missing'; target: 'libreoffice' };
  /** Something can still arrive (an install in flight, or one to retry): a parkable run waits instead of failing. */
  waitable: boolean;
}

/** Index of the quote closing the one at `open`; only quotes and escapes matter here. */
function closingQuote(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '"') return i;
  }
  return text.length;
}

/** Index of the bracket closing the group that starts just before `from`, skipping quoted text and nested groups. */
function matchingClose(text: string, from: number, closer: ')' | '`'): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const end = text.indexOf("'", i + 1); i = end < 0 ? text.length : end; continue; }
    if (c === '"') { i = closingQuote(text, i); continue; }
    if (text.startsWith('$(', i) || (c === '(' && closer === ')')) { depth++; i++; continue; }
    if (c === closer && closer === ')' && depth > 0) { depth--; if (depth === 0) return i; }
    if (c === closer && closer === '`') return i;
  }
  return -1;
}

interface Scan {
  /** Command-position words found so far. */
  words: string[];
  /** The next word would start a simple command. */
  expectCommand: boolean;
  /** A wrapper word (sudo, env…) was seen: its options and assignments are not the command. */
  prefixPending: boolean;
  /** That wrapper is `command`: a later -v / -V option only looks the name up instead of running it. */
  commandWrapper: boolean;
  /** The next word is a redirection target, not a command. */
  redirectTarget: boolean;
  /** The next word is only looked up (`command -v NAME`), not run. */
  lookupTarget: boolean;
  skipUntilDo: boolean;
  caseDepth: number;
  current: string;
  started: boolean;
  /** The word opened with a quote or an escape: a quoted `FOO=bar` is not an assignment. */
  quotedStart: boolean;
  /** The word contains a substitution: what it names is only known when the shell runs. */
  dynamic: boolean;
}

function endWord(scan: Scan): void {
  if (!scan.started) return;
  const word = scan.current;
  scan.started = false; scan.current = ''; scan.quotedStart = false;
  const dynamic = scan.dynamic; scan.dynamic = false;
  if (scan.skipUntilDo) { if (word === 'do') scan.skipUntilDo = false; return; }
  if (scan.caseDepth > 0) { if (word === 'case') scan.caseDepth++; else if (word === 'esac') scan.caseDepth--; return; }
  if (scan.redirectTarget) { scan.redirectTarget = false; return; }
  if (scan.lookupTarget) { scan.lookupTarget = false; scan.expectCommand = false; return; }
  if (!scan.expectCommand) return;
  // `command -v NAME` / `command -V NAME` (also bundled, -pv) looks NAME up; it does not run it.
  if (scan.prefixPending && scan.commandWrapper && /^-[^-]*[vV]/.test(word)) {
    scan.prefixPending = false; scan.commandWrapper = false; scan.lookupTarget = true; return;
  }
  if (!scan.quotedStart && (ASSIGNMENT.test(word) || (scan.prefixPending && word.startsWith('-')))) return;
  if (COMMAND_PREFIXES.has(word)) { scan.prefixPending = true; scan.commandWrapper = word === 'command'; return; }
  scan.prefixPending = false; scan.commandWrapper = false;
  if (word === 'for' || word === 'select') { scan.skipUntilDo = true; return; }
  if (word === 'case') { scan.caseDepth = 1; scan.expectCommand = false; return; }
  if (CLOSING_KEYWORDS.has(word)) { scan.expectCommand = false; return; }
  if (!LIST_KEYWORDS.has(word) && !dynamic) scan.words.push(word);
  scan.expectCommand = LIST_KEYWORDS.has(word);
}

/** Scan a command substitution as the command it is; the outer word only learns that it is no longer a plain literal. */
function scanNested(text: string, scan: Scan): void {
  const outer = { current: scan.current, started: scan.started, quotedStart: scan.quotedStart };
  scan.current = ''; scan.started = false; scan.quotedStart = false;
  scan.expectCommand = true; scan.prefixPending = false; scan.commandWrapper = false;
  scan.redirectTarget = false; scan.lookupTarget = false;
  scanCommands(text, scan);
  scan.current = `${outer.current}\u0000`; scan.started = true; scan.quotedStart = outer.quotedStart; scan.dynamic = true;
}

/** Add a double-quoted stretch to the current word: literal text stays, substitutions are scanned as commands. */
function readDoubleQuoted(text: string, open: number, scan: Scan): number {
  const close = closingQuote(text, open);
  for (let i = open + 1; i < close; i++) {
    if (text[i] === '\\') { scan.current += text[i + 1] ?? ''; i++; continue; }
    if (text.startsWith('$(', i) || text[i] === '`') {
      const backtick = text[i] === '`';
      const end = matchingClose(text, i + 1, backtick ? '`' : ')');
      scanNested(text.slice(i + (backtick ? 1 : 2), end < 0 ? text.length : end), scan);
      i = end < 0 ? close : end;
      continue;
    }
    scan.current += text[i];
  }
  return close;
}

/** Skip a heredoc body; `i` sits on the first `<`. Returns the index after the terminator line. */
function skipHeredoc(text: string, i: number): number {
  let cursor = i + 2;
  const stripTabs = text[cursor] === '-';
  if (stripTabs) cursor++;
  if (text[cursor] === "'" || text[cursor] === '"') cursor++;
  const delimiter = /^[A-Za-z0-9_]+/.exec(text.slice(cursor))?.[0] ?? '';
  const bodyStart = text.indexOf('\n', cursor);
  if (!delimiter || bodyStart < 0) return text.length;
  let offset = bodyStart + 1;
  for (const line of text.slice(offset).split('\n')) {
    offset += line.length + 1;
    if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) return offset;
  }
  return text.length;
}

/** Command-position words of one shell fragment; substitutions inside are scanned as commands of their own. */
function scanCommands(text: string, scan: Scan): void {
  const n = text.length;
  const dropDigits = () => {
    // `2>file`, `2<<EOF`: the digits collected so far were a file descriptor, not a word.
    if (scan.started && DIGITS.test(scan.current)) { scan.started = false; scan.current = ''; scan.quotedStart = false; scan.dynamic = false; }
  };
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (WHITESPACE.test(c)) { endWord(scan); if (c === '\n') scan.expectCommand = true; continue; }
    if (c === '#' && !scan.started) { const end = text.indexOf('\n', i); i = end < 0 ? n : end - 1; continue; }
    if (c === '\\' && i + 1 < n) {
      // A backslash-newline continues the line; any other escaped character is a literal.
      if (text[i + 1] === '\n') { i++; continue; }
      if (!scan.started) scan.quotedStart = true;
      scan.current += text[i + 1]; scan.started = true; i++; continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (!scan.started) scan.quotedStart = true;
      scan.current += text.slice(i + 1, end < 0 ? n : end); scan.started = true; i = end < 0 ? n : end; continue;
    }
    if (c === '"') {
      if (!scan.started) scan.quotedStart = true;
      i = readDoubleQuoted(text, i, scan);
      scan.started = true; continue;
    }
    if (text.startsWith('$(', i) && text[i + 2] === '(') { const end = text.indexOf('))', i + 3); scan.current += '\u0000'; scan.dynamic = true; scan.started = true; i = end < 0 ? n : end + 1; continue; }
    if (text.startsWith('$(', i)) {
      const end = matchingClose(text, i + 1, ')');
      scanNested(text.slice(i + 2, end < 0 ? n : end), scan);
      i = end < 0 ? n : end; continue;
    }
    if (c === '`') {
      const end = matchingClose(text, i + 1, '`');
      scanNested(text.slice(i + 1, end < 0 ? n : end), scan);
      i = end < 0 ? n : end; continue;
    }
    if ((c === '<' || c === '>') && text[i + 1] === '(') {
      endWord(scan);
      const end = matchingClose(text, i + 1, ')');
      scanNested(text.slice(i + 2, end < 0 ? n : end), scan);
      scan.expectCommand = false; i = end < 0 ? n : end; continue;
    }
    if (c === '<' && text.startsWith('<<', i) && !text.startsWith('<<<', i)) { dropDigits(); endWord(scan); i = skipHeredoc(text, i) - 1; continue; }
    if (c === '<' || c === '>' || (c === '&' && text[i + 1] === '>')) {
      dropDigits(); endWord(scan);
      scan.redirectTarget = true;
      i = c === '&' ? i + 1 : i + (['>', '&', '<'].includes(text[i + 1]) ? 1 : 0);
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || (c === '{' && !scan.started && BRACE_KEYWORD.test(text[i + 1] ?? '\n')) || (c === '(' && !scan.started)) {
      endWord(scan);
      scan.expectCommand = true; scan.prefixPending = false; scan.commandWrapper = false; scan.redirectTarget = false; scan.lookupTarget = false;
      continue;
    }
    if ((c === ')' || c === '}') && !scan.started) { endWord(scan); scan.expectCommand = false; continue; }
    scan.current += c; scan.started = true;
  }
  endWord(scan);
}

/** Every soffice / libreoffice the command runs as a program, spelled the way the command spells it. */
export function libreOfficeCommands(command: string): string[] {
  const scan: Scan = { words: [], expectCommand: true, prefixPending: false, commandWrapper: false, redirectTarget: false, lookupTarget: false, skipUntilDo: false, caseDepth: 0, current: '', started: false, quotedStart: false, dynamic: false };
  scanCommands(command, scan);
  return scan.words.filter((word) => LIBREOFFICE_COMMANDS.has(path.posix.basename(word)));
}

function pathLookup(pathEnv: string | undefined, name: string): string | null {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, name);
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* next entry */ }
  }
  return null;
}

/** Does a bare name resolve on the child PATH? The managed-only seam ignores copies outside the managed root. */
function onChildPath(pathEnv: string | undefined, name: string, managedRoot: string): boolean {
  const hit = pathLookup(pathEnv, name);
  return hit !== null && (process.env[LIBREOFFICE_MANAGED_ONLY_ENV] !== '1' || hit.startsWith(`${managedRoot}${path.sep}`));
}

/**
 * Is the program this fixed path points at there? The well-known application locations answer through the lookup
 * (so the managed-only seam hides the system ones); any other explicit path only if it really is on disk.
 */
function fixedPathResolvable(word: string): boolean {
  // The managed-only seam: a soffice outside the managed root (system app, Homebrew link) does not exist for this run.
  if (process.env[LIBREOFFICE_MANAGED_ONLY_ENV] === '1') return fs.existsSync(word) && path.resolve(word).startsWith(`${resolveLibreOfficeRoot()}${path.sep}`);
  return LIBREOFFICE_SEARCH_PATHS.includes(word) ? getLibreOfficeCandidates().includes(word) : fs.existsSync(word);
}

const failureReason: Record<LibreOfficeRuntimeErrorCode, string> = {
  LIBREOFFICE_RUNTIME_OFFLINE: 'the download servers are unreachable',
  LIBREOFFICE_RUNTIME_INSTALL_FAILED: 'the install did not finish',
  LIBREOFFICE_RUNTIME_CHECKSUM_MISMATCH: 'the download did not pass verification',
  LIBREOFFICE_RUNTIME_UNSUPPORTED: 'it is not supported on this system',
  LIBREOFFICE_RUNTIME_FALLBACK: 'it is not supported on this system',
};

function refuse(code: ManagedLibreOfficeBlock['code'], percent: number | undefined): ManagedLibreOfficeBlock {
  const envBlocked = { class: 'runtime_missing', target: 'libreoffice' } as const;
  const notRun = 'This command was not run, so nothing was changed. ';
  if (code === 'LIBREOFFICE_RUNTIME_UNSUPPORTED') {
    return {
      ok: false, code, envBlocked, waitable: false,
      error: `${notRun}Converting documents with LibreOffice is not available on this system. `
        + 'Continue in a way that does not need document conversion, or tell the user.',
    };
  }
  if (code !== 'LIBREOFFICE_RUNTIME_INSTALLING') {
    return {
      ok: false, code, envBlocked, waitable: true,
      error: `${notRun}Neo could not finish setting up LibreOffice, the document converter (${failureReason[code]}). `
        + 'The chat shows a card with a retry button the user can press. '
        + 'Until it is ready, continue in a way that does not need document conversion, or tell the user.',
    };
  }
  return {
    ok: false, code, envBlocked, waitable: true,
    error: `${notRun}Neo is preparing LibreOffice, the document converter (a one-time download)${percent === undefined ? '' : ` — ${Math.round(percent)}% done`}. `
      + 'The chat shows the progress. Once the card says it is ready, run this command again.',
  };
}

/**
 * LibreOffice started through Bash runs inside the sandbox: it cannot bind its single-instance pipe where it
 * normally would (the profile only allows the owner-approved location) and cannot write its settings under HOME.
 * Point both at places the sandbox already grants. Values the caller set itself are left alone.
 */
function prepareLibreOfficeEnv(env: Record<string, string>, logger?: ToolContext['logger']): void {
  const tmp = process.env.TMPDIR || os.tmpdir();
  env.UserInstallation ??= pathToFileURL(path.join(tmp, OFFICE_PROFILE_DIRNAME)).href;
  env.OSL_SOCKET_PATH ??= OFFICE_IPC_SOCKET_DIR;
  logger?.debug('Bash child env: LibreOffice pointed at its sandbox-writable pipe and profile');
}

/**
 * 解析得到 ⇒ 原样放行；由托管副本解析 ⇒ PATH 末尾追加（如果还没有）+ 沙箱可用的环境变量；
 * 本机没有 ⇒ 不执行，返回 fail-closed 结果并（除非关了自动安装）后台起一次安装。
 */
export function applyManagedLibreOffice(
  env: Record<string, string>,
  command: string,
  logger?: ToolContext['logger'],
): ManagedLibreOfficeBlock | null {
  if (process.platform === 'win32') return null;
  const words = libreOfficeCommands(command);
  if (words.length === 0) return null;
  const managedRoot = resolveLibreOfficeRoot();
  const bare = words.filter((word) => !word.includes('/'));
  const bareMissing = bare.filter((word) => !onChildPath(env.PATH, word, managedRoot));
  const fixedMissing = words.filter((word) => word.includes('/') && !fixedPathResolvable(word));
  const managedPath = managedLibreOfficePath(managedRoot);
  // Nothing to add unless the managed copy is (or is about to be) what answers the command.
  if (bareMissing.length + fixedMissing.length === 0
    && !(fs.existsSync(managedPath) && bare.length > 0 && bare.every((word) => (pathLookup(env.PATH, word) ?? '').startsWith(`${managedRoot}${path.sep}`)))) return null;

  if (fs.existsSync(managedPath) && fixedMissing.length === 0) {
    const managedDir = path.dirname(managedPath);
    if (bareMissing.length > 0 && !(env.PATH ?? '').split(path.delimiter).includes(managedDir)) {
      const shadowedBySeam = process.env[LIBREOFFICE_MANAGED_ONLY_ENV] === '1'
        && bareMissing.some((word) => {
          const hit = pathLookup(env.PATH, word);
          return hit !== null && !hit.startsWith(`${managedRoot}${path.sep}`);
        });
      // Production always appends to the END of PATH. Only under the managed-only seam, when a system soffice
      // sits earlier on PATH (e.g. /opt/homebrew/bin/soffice on a dev machine), place the managed copy ahead of it
      // so the seam truly runs the managed copy instead of silently falling back to the system binary.
      env.PATH = !env.PATH ? managedDir : shadowedBySeam ? `${managedDir}${path.delimiter}${env.PATH}` : `${env.PATH}${path.delimiter}${managedDir}`;
      logger?.debug('Bash child env: added managed LibreOffice directory to PATH', { placement: shadowedBySeam ? 'seam_front' : 'tail' });
    }
    prepareLibreOfficeEnv(env, logger);
    return null;
  }

  let state = getLibreOfficeState();
  // Some LibreOffice exists (the lookup found one): a fixed path that is not there is the command's own mistake to report.
  if (state.phase === 'installed') return null;
  if ((state.phase === 'missing' || state.phase === 'failed') && process.env.CODE_AGENT_NO_RUNTIME_AUTOINSTALL !== '1') {
    // 单飞在 ensureLibreOffice：安装期间再撞到不会重复起；失败后再撞到就是一次新的重试。
    logger?.info('Bash command needs LibreOffice; starting the managed install');
    void ensureLibreOffice().then(
      (result) => { if (!result.ok) logger?.warn('LibreOffice background install failed', { code: result.error.code }); },
      (error: unknown) => { logger?.warn('LibreOffice background install threw', { error: error instanceof Error ? error.message : String(error) }); },
    );
    state = getLibreOfficeState();
  }
  return refuse(state.phase === 'failed' ? state.error?.code ?? 'LIBREOFFICE_RUNTIME_INSTALL_FAILED'
    : state.phase === 'unsupported' ? 'LIBREOFFICE_RUNTIME_UNSUPPORTED' : 'LIBREOFFICE_RUNTIME_INSTALLING',
  state.phase === 'installing' ? state.percent : undefined);
}
