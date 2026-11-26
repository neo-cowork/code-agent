// ============================================================================
// ReadOnlyProbePlan 编译器 — 把一条「纯只读探测」shell 命令编译成可信的结构化计划。
//
// 设计见 docs/design/approval-card-redesign.md「路线 B」。要点：
// - 手写识别器，只认文法白名单；任何认不出的 token（子 shell / $(…) / 反引号 / 写文件重定向 /
//   tee / 未知 flag / 未知 import / & 后台 …）一律返回 null，调用方走原审批链（fail-closed）。
// - 变量只允许字面赋值（VAR="x"），编译期折叠，计划里不剩任何动态展开。
// - python3 -c 只识别一个极小 AST 子集，并被转换成宿主侧的 stat/list 操作，从不交给解释器。
// - 本文件只做「语法 → 计划」，不碰文件系统；路径授权与执行在 readOnlyProbeExecutor.ts。
// ============================================================================

import { compileReadOnlyFileLoop, type ProbeFileLoop } from './readOnlyProbeFileLoop';
import { compileToolCommand, expandLiteralForLoop, type LoopBodyBinding, type ProbeToolCommand } from './readOnlyProbeTools';

type ProbeStream = 'out' | 'err' | 'null';

/** 一条简单命令的 fd1 / fd2 最终去向（按 shell 从左到右的重定向语义折叠）。 */
export interface ProbeRedirect {
  out: ProbeStream;
  err: ProbeStream;
}

export type PyExpr =
  | { t: 'str'; v: string }
  | { t: 'name'; n: string }
  | { t: 'call'; fn: 'exists' | 'isdir' | 'dirname' | 'listdir'; arg: PyExpr };

export type PyStmt =
  | { t: 'import' }
  | { t: 'assign'; n: string; e: PyExpr }
  | { t: 'print'; args: PyExpr[] }
  | { t: 'try'; body: PyStmt[]; excName: string | null; handler: PyStmt[] };

export type ProbeCommand =
  | ProbeFileLoop
  | ProbeToolCommand
  | { kind: 'noop' }
  | { kind: 'test'; flag: '-e' | '-f' | '-d'; path: string }
  /** `if <test>; then / else` 的一个分支语句：条件成立与否（negate 取反）决定 cmd 执不执行；start = 这段 if 的第一条语句。 */
  | { kind: 'when'; test: Extract<ProbeCommand, { kind: 'test' }>; negate: boolean; start: boolean; cmd: ProbeCommand }
  | { kind: 'echo'; text: string; newline: boolean }
  | { kind: 'printf'; text: string }
  | { kind: 'command-v'; name: string }
  | { kind: 'ls'; flags: string[]; paths: string[]; headLines?: number }
  /** `stat -f <format> [-t <timefmt>] <path>…`（macOS BSD 语法，只打印元数据）。 */
  | { kind: 'stat'; format: string; timeFormat?: string; paths: string[] }
  | { kind: 'cd'; path: string }
  | { kind: 'file-read'; program: 'cat' | 'wc' | 'head'; flags: string[]; paths: string[] }
  | { kind: 'xattr'; paths: string[] }
  | { kind: 'id-un' }
  | { kind: 'whoami' }
  | { kind: 'python'; program: PyStmt[] };

interface ProbeStep {
  /** 与前一步的连接符；第一步恒为 ';'。 */
  op: ';' | '&&' | '||';
  cmd: ProbeCommand;
  redirect: ProbeRedirect;
  /** 该步的程序名（日志只记程序名，不记路径/内容）。 */
  program: string;
  /** 该步对应的原文片段，供用户规则逐段匹配。 */
  source: string;
  /** Additional literal pipeline programs, each checked against user rules. */
  extraSources?: string[];
}

export interface ReadOnlyProbePlan {
  steps: ProbeStep[];
}

const RESERVED_VAR_NAMES = new Set([
  'PATH', 'IFS', 'HOME', 'SHELL', 'CDPATH', 'PWD', 'OLDPWD', 'ENV', 'BASH_ENV', 'TZ', 'LANG', 'USER', 'LOGNAME',
]);
const LS_FLAG_CHARS = 'lahAFdtrSpOi@e1ns';
const MAX_COMMAND_LENGTH = 8000;
const MAX_STAT_FORMAT = 512;
// A typed echo-only placeholder: never passed to a shell or interpreted as a path.
export const PROBE_EXIT_STATUS = '\u0001probe-status\u0001';

interface Word {
  value: string;
  /** 来自纯字面（无引号、无变量展开）。程序名必须是纯字面。 */
  bare: boolean;
  assignName?: string;
}
type Token =
  | { type: 'word'; word: Word; start: number; end: number }
  | { type: 'op'; op: ';' | '&&' | '||'; start: number; end: number }
  | { type: 'pipe'; start: number; end: number }
  | { type: 'redir'; fd: 1 | 2; target: 'null' | 1 | 2; start: number; end: number };

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNQUOTED_FORBIDDEN = new Set(['$', '`', '\\', '(', ')', '{', '}', '*', '?', '[', ']', '<', '>', '|', '&', '!', '#', '"', "'"]);

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

/** 一个未加引号的词到此为止：结尾、空白或命令分隔符。 */
function isWordEnd(ch: string | undefined): boolean {
  return ch === undefined || isBlank(ch) || ch === '\n' || ch === ';' || ch === '&' || ch === '|';
}

function tokenize(src: string, vars: Map<string, string>, home: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  let atStart = true;
  while (i < src.length) {
    const ch = src[i];
    if (isBlank(ch)) { i++; continue; }
    if (ch === '\r') return null;
    if (ch === '\n') { tokens.push({ type: 'op', op: ';', start: i, end: i + 1 }); atStart = true; i++; continue; }
    if (ch === ';') {
      if (src[i + 1] === ';') return null;
      tokens.push({ type: 'op', op: ';', start: i, end: i + 1 }); atStart = true; i++; continue;
    }
    if (ch === '&' || ch === '|') {
      if (src[i + 1] === ch) {
        if (src[i + 2] === ch || src[i + 2] === '&' || src[i + 2] === '|') return null;
        tokens.push({ type: 'op', op: ch === '&' ? '&&' : '||', start: i, end: i + 2 }); atStart = true; i += 2; continue;
      }
      if (ch === '|') { tokens.push({ type: 'pipe', start: i, end: i + 1 }); i++; atStart = true; continue; }
      return null;
    }
    // 重定向只在 token 起点识别，且只认 2>&1 / >/dev/null / 2>/dev/null / 1>/dev/null / 1>&2
    const redir = /^([12]?)>(?:&([12])|[ \t]*\/dev\/null)(?![\w/.-])/.exec(src.slice(i));
    if (redir) {
      const fd = (redir[1] === '2' ? 2 : 1) as 1 | 2;
      const target = redir[2] ? (Number(redir[2]) as 1 | 2) : 'null';
      if (target !== 'null' && target === fd) return null;
      tokens.push({ type: 'redir', fd, target, start: i, end: i + redir[0].length });
      atStart = false;
      i += redir[0].length;
      continue;
    }
    // ---- word ----
    const start = i;
    let value = '';
    let bare = true;
    let assignName: string | undefined;
    let first = true;
    while (i < src.length) {
      const c = src[i];
      if (isBlank(c) || c === '\n' || c === ';' || c === '&' || c === '|') break;
      if (c === '>' ) break;
      if (c === "'") {
        const close = src.indexOf("'", i + 1);
        if (close < 0) return null;
        value += src.slice(i + 1, close);
        bare = false; i = close + 1; first = false; continue;
      }
      if (c === '"') {
        i++;
        bare = false;
        for (;;) {
          if (i >= src.length) return null;
          const d = src[i];
          if (d === '"') { i++; break; }
          if (d === '`') return null;
          if (d === '\\') {
            const nxt = src[i + 1];
            if (nxt === 'n' || nxt === 't') { value += d + nxt; i += 2; continue; }
            return null;
          }
          if (d === '$') {
            if (src.slice(i, i + 2) === '$?') {
              value += PROBE_EXIT_STATUS;
              i += 2;
              continue;
            }
            const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(src.slice(i));
            const plain = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
            const m = braced ?? plain;
            if (!m || !vars.has(m[1])) return null;
            value += vars.get(m[1]);
            i += m[0].length;
            continue;
          }
          value += d; i++;
        }
        first = false;
        continue;
      }
      if (c === '~' && first) {
        const nxt = src[i + 1];
        if (nxt === undefined || nxt === '/' || isBlank(nxt) || nxt === '\n' || nxt === ';' || nxt === '&' || nxt === '|') {
          value += home; i++; first = false; bare = false; continue;
        }
        return null;
      }
      if (c === '=' && atStart && !first && assignName === undefined && bare && VAR_NAME.test(value)) {
        // 形如 NAME=…：只在词首的未引号标识符后识别
        assignName = value;
        value += '=';
        i++;
        continue;
      }
      if (c === '=' && first) return null;
      if (c === '~' && assignName !== undefined && value.length === assignName.length + 1) return null;
      // 独立的 `[` / `]`（test 的别名 `[ -e x ]`）：只在词首、后面紧跟分隔符时才是字面量，不构成通配符
      if ((c === '[' || c === ']') && value === '' && isWordEnd(src[i + 1])) { value += c; i++; first = false; continue; }
      if (UNQUOTED_FORBIDDEN.has(c)) return null;
      value += c; i++; first = false;
    }
    if (i === start) return null;
    if (assignName !== undefined) {
      value = value.slice(assignName.length + 1);
      vars.set(assignName, value);
    }
    atStart = false;
    tokens.push({ type: 'word', word: { value, bare, assignName }, start, end: i });
  }
  return tokens;
}

// ----------------------------------------------------------------------------
// Python 子集
// ----------------------------------------------------------------------------

const PY_KEYWORDS = new Set([
  'import', 'try', 'except', 'print', 'os', 'as', 'if', 'else', 'for', 'while', 'def', 'class', 'lambda', 'None', 'True', 'False',
  'exec', 'eval', 'open', '__import__', 'from', 'with', 'del', 'global', 'nonlocal', 'return', 'raise', 'finally', 'and', 'or', 'not', 'in', 'is',
]);

class PyParseError extends Error {}

class PyExprParser {
  private pos = 0;
  constructor(private readonly s: string) {}

  parseTopLevelArgs(): PyExpr[] {
    const args: PyExpr[] = [];
    this.skipWs();
    if (this.s[this.pos] === ')') return args;
    for (;;) {
      args.push(this.expr());
      this.skipWs();
      if (this.s[this.pos] === ',') { this.pos++; this.skipWs(); continue; }
      break;
    }
    return args;
  }

  /** 解析 `expr` 并要求之后正好到达 `)` 或结尾。 */
  parseSingle(): PyExpr {
    const e = this.expr();
    this.skipWs();
    if (this.pos !== this.s.length) throw new PyParseError('trailing');
    return e;
  }

  atClose(): boolean {
    this.skipWs();
    return this.s[this.pos] === ')';
  }

  consumeClose(): void {
    this.skipWs();
    if (this.s[this.pos] !== ')') throw new PyParseError('close');
    this.pos++;
  }

  atEnd(): boolean {
    this.skipWs();
    return this.pos === this.s.length;
  }

  private skipWs(): void {
    while (this.pos < this.s.length && (this.s[this.pos] === ' ')) this.pos++;
  }

  expr(): PyExpr {
    this.skipWs();
    const c = this.s[this.pos];
    if (c === "'" || c === '"') {
      const close = this.s.indexOf(c, this.pos + 1);
      if (close < 0) throw new PyParseError('unterminated');
      const v = this.s.slice(this.pos + 1, close);
      if (/[\\\n\0]/.test(v)) throw new PyParseError('escape');
      this.pos = close + 1;
      this.skipWs();
      const nxt = this.s[this.pos];
      if (nxt === "'" || nxt === '"') throw new PyParseError('adjacent');
      return { t: 'str', v };
    }
    const call = /^os\.(path\.(exists|isdir|dirname)|(listdir))\(/.exec(this.s.slice(this.pos));
    if (call) {
      this.pos += call[0].length;
      const arg = this.expr();
      this.consumeClose();
      return { t: 'call', fn: (call[2] ?? call[3]) as 'exists' | 'isdir' | 'dirname' | 'listdir', arg };
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.pos));
    if (id && !PY_KEYWORDS.has(id[0])) {
      this.pos += id[0].length;
      const nxt = this.s[this.pos];
      if (nxt === '(' || nxt === '.' || nxt === '[') throw new PyParseError('name-use');
      return { t: 'name', n: id[0] };
    }
    throw new PyParseError('expr');
  }
}

interface PyLine { indent: number; text: string }

function parsePyBlock(lines: PyLine[], from: number, indent: number, state: { imported: boolean }): { stmts: PyStmt[]; next: number } {
  const stmts: PyStmt[] = [];
  let idx = from;
  while (idx < lines.length) {
    const line = lines[idx];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new PyParseError('indent');
    const text = line.text;
    if (text === 'import os') {
      state.imported = true;
      stmts.push({ t: 'import' }); idx++; continue;
    }
    if (text === 'try:') {
      const body = parsePyBlock(lines, idx + 1, indent + 4, state);
      if (body.stmts.length === 0) throw new PyParseError('empty try');
      const exc = lines[body.next];
      if (exc?.indent !== indent) throw new PyParseError('no except');
      const m = /^except Exception(?: as ([A-Za-z_][A-Za-z0-9_]*))?:$/.exec(exc.text);
      if (!m) throw new PyParseError('except form');
      if (m[1] && (PY_KEYWORDS.has(m[1]))) throw new PyParseError('exc name');
      const handler = parsePyBlock(lines, body.next + 1, indent + 4, state);
      if (handler.stmts.length === 0) throw new PyParseError('empty handler');
      stmts.push({ t: 'try', body: body.stmts, excName: m[1] ?? null, handler: handler.stmts });
      idx = handler.next; continue;
    }
    if (text.startsWith('print(')) {
      if (!state.imported && text.includes('os.')) throw new PyParseError('os before import');
      const p = new PyExprParser(text.slice('print('.length));
      const args = p.parseTopLevelArgs();
      p.consumeClose();
      if (!p.atEnd()) throw new PyParseError('print trailing');
      stmts.push({ t: 'print', args }); idx++; continue;
    }
    const assign = /^([A-Za-z_][A-Za-z0-9_]*) ?=(?!=) ?(.+)$/.exec(text);
    if (assign && !PY_KEYWORDS.has(assign[1])) {
      if (!state.imported && assign[2].includes('os.')) throw new PyParseError('os before import');
      stmts.push({ t: 'assign', n: assign[1], e: new PyExprParser(assign[2]).parseSingle() });
      idx++; continue;
    }
    throw new PyParseError('statement');
  }
  return { stmts, next: idx };
}

function compilePython(code: string): PyStmt[] | null {
  if (/[\0\t\r#;]/.test(code)) return null;
  const lines: PyLine[] = [];
  for (const raw of code.split('\n')) {
    if (raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;
    if (raw !== raw.trimEnd()) return null;
    lines.push({ indent, text: raw.trimStart() });
  }
  if (lines.length === 0) return null;
  // 整段脚本缩进基线必须为 0（python -c 不允许前导缩进）
  try {
    const { stmts, next } = parsePyBlock(lines, 0, 0, { imported: false });
    return next === lines.length ? stmts : null;
  } catch (e) {
    if (e instanceof PyParseError) return null;
    throw e;
  }
}

// ----------------------------------------------------------------------------
// shell 命令
// ----------------------------------------------------------------------------

function foldRedirect(redirs: Extract<Token, { type: 'redir' }>[]): ProbeRedirect {
  const fd: Record<1 | 2, ProbeStream> = { 1: 'out', 2: 'err' };
  for (const r of redirs) {
    if (r.target === 'null') fd[r.fd] = 'null';
    else fd[r.fd] = fd[r.target];
  }
  return { out: fd[1], err: fd[2] };
}

function compileEchoText(words: string[]): { text: string; newline: boolean } | null {
  let newline = true;
  let args = words;
  if (args[0] === '-n') { newline = false; args = args.slice(1); }
  // 首参形如 -e/-E/-ne 是 echo 选项（各 shell 语义不同），不模拟；`---x` 这类不是选项，按字面输出
  if (args[0] !== undefined && /^-[neE]+$/.test(args[0])) return null;
  if (args.some((a) => a.includes('\\'))) return null;
  return { text: args.join(' '), newline };
}

function compilePrintf(words: string[]): string | null {
  const [format, ...args] = words;
  if (format === undefined || format.startsWith('-')) return null;
  let out = '';
  let used = 0;
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === '%') {
      const nxt = format[i + 1];
      if (nxt === '%') { out += '%'; i++; continue; }
      if (nxt === 's' && used < args.length) { out += args[used++]; i++; continue; }
      return null;
    }
    if (c === '\\') {
      const nxt = format[i + 1];
      if (nxt === 'n') { out += '\n'; i++; continue; }
      if (nxt === 't') { out += '\t'; i++; continue; }
      return null;
    }
    out += c;
  }
  // 参数个数必须与 %s 个数一致（bash 会在多余参数时循环重用格式串，这里不去模拟）
  return used === args.length ? out : null;
}

function compileSimple(words: Word[]): { cmd: ProbeCommand; program: string } | null {
  const [head, ...rest] = words;
  if (!head.bare) return null;
  const argv = rest.map((w) => w.value);
  const program = head.value;
  if (program !== 'echo' && argv.some((word) => word.includes(PROBE_EXIT_STATUS))) return null;
  switch (program) {
    case 'cd':
      return argv.length === 1 && argv[0] !== '' && !argv[0].startsWith('-') ? { program, cmd: { kind: 'cd', path: argv[0] } } : null;
    case 'cat':
    case 'wc':
    case 'head': {
      let rest = [...argv];
      const flags: string[] = [];
      if (program === 'wc') {
        if (!['-c', '-l'].includes(rest[0])) return null;
        flags.push(rest.shift() as string);
      } else if (program === 'head') {
        let count = '10';
        if (/^-\d+$/.test(rest[0] ?? '')) count = (rest.shift() as string).slice(1);
        else if (rest[0] === '-n') { rest.shift(); count = rest.shift() ?? ''; }
        if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 10000) return null;
        flags.push('-n', String(Number(count)));
      }
      const endOfFlags = rest[0] === '--';
      if (endOfFlags) rest = rest.slice(1);
      if (!rest.length || rest.some((operand) => !operand || operand === '-' || (!endOfFlags && operand.startsWith('-')))) return null;
      return { program, cmd: { kind: 'file-read', program, flags, paths: rest } };
    }
    case 'test':
    case '[': {
      // `[ -e|-f|-d <path> ]` 是 test 的别名：只认恰好以 ] 收尾的这一个形状
      const args = program === '[' ? (argv.length === 3 && argv[2] === ']' ? argv.slice(0, -1) : null) : argv;
      if (args?.length !== 2 || !['-e', '-f', '-d'].includes(args[0]) || args[1] === '') return null;
      return { program, cmd: { kind: 'test', flag: args[0] as '-e' | '-f' | '-d', path: args[1] } };
    }
    case 'stat': {
      // 只认 `stat -f <format> [-t <timefmt>] <path>…`（-t 在前在后都行）：只打印元数据；其它旗标、缺省格式不认
      let args = argv;
      let format: string | undefined;
      let timeFormat: string | undefined;
      for (let option = 0; option < 2; option++) {
        const [flag = '', next] = args;
        const name = flag === '-f' || flag.startsWith('-f') ? '-f' : flag === '-t' || flag.startsWith('-t') ? '-t' : null;
        if (!name) break;
        const argument = flag.length > 2 ? flag.slice(2) : next;
        const seen = name === '-f' ? format : timeFormat;
        if (seen !== undefined || argument === undefined || argument === '' || argument.startsWith('-') || argument.length > MAX_STAT_FORMAT || /\p{Cc}/u.test(argument)) return null;
        if (name === '-f') format = argument; else timeFormat = argument;
        args = flag.length > 2 ? args.slice(1) : args.slice(2);
      }
      if (format === undefined || args.length === 0 || args.some((operand) => operand === '' || operand.startsWith('-'))) return null;
      return { program, cmd: { kind: 'stat', format, timeFormat, paths: args } };
    }
    case 'echo': {
      const e = compileEchoText(argv);
      return e ? { program, cmd: { kind: 'echo', ...e } } : null;
    }
    case 'printf': {
      const text = compilePrintf(argv);
      return text === null ? null : { program, cmd: { kind: 'printf', text } };
    }
    case 'command': {
      if (argv.length < 2 || argv.length > 33 || argv[0] !== '-v' || argv.slice(1).some((name) => !/^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/.test(name))) return null;
      // 多名字：各 shell 对「部分找不到」的退出码不一致，这里一律在任一缺失时返回 1（非零 → 调用方走审批）。
      return argv.length === 2 ? { program, cmd: { kind: 'command-v', name: argv[1] } } : { program, cmd: { kind: 'which', names: argv.slice(1), builtins: true } };
    }
    case 'ls': {
      const flags: string[] = [];
      const paths: string[] = [];
      let endOfFlags = false;
      for (const a of argv) {
        if (!endOfFlags && a === '--') { endOfFlags = true; continue; }
        if (!endOfFlags && a.startsWith('-')) {
          if (!/^-[A-Za-z@1]+$/.test(a) || [...a.slice(1)].some((ch) => !LS_FLAG_CHARS.includes(ch))) return null;
          flags.push(a);
          continue;
        }
        if (a === '') return null;
        paths.push(a);
      }
      return { program, cmd: { kind: 'ls', flags, paths } };
    }
    case 'xattr': {
      if (argv.length < 2 || argv[0] !== '-l' || argv.slice(1).some((a) => a === '' || a.startsWith('-'))) return null;
      return { program, cmd: { kind: 'xattr', paths: argv.slice(1) } };
    }
    case 'id':
      return argv.length === 1 && argv[0] === '-un' ? { program, cmd: { kind: 'id-un' } } : null;
    case 'whoami':
      return argv.length === 0 ? { program, cmd: { kind: 'whoami' } } : null;
    case 'python3': {
      if (argv[0] !== '-c') return compileToolCommand(program, argv);
      if (argv.length !== 2) return null;
      const program2 = compilePython(argv[1]);
      return program2 ? { program, cmd: { kind: 'python', program: program2 } } : null;
    }
    default:
      return compileToolCommand(program, argv);
  }
}

export interface ProbeCompileContext {
  homeDir: string;
  platform: NodeJS.Platform;
}

interface ProbeScope {
  /** 循环体内：允许一层 `if <test>; then …; [else …;] fi`。 */
  loopBody: boolean;
  /** 编译期已知值的变量：目前只有绑定值的循环变量，只在双引号里折叠。 */
  vars: Map<string, string>;
}

const IF_KEYWORDS = ['then', 'else', 'fi'] as const;

/** 编译；任何一处不能证明只读就返回 null（调用方原样走审批）。 */
export function compileReadOnlyProbePlan(command: string, ctx: ProbeCompileContext): ReadOnlyProbePlan | null {
  const steps = compileCommand(command, ctx, { loopBody: false, vars: new Map<string, string>() });
  return steps ? { steps } : null;
}

function compileCommand(command: string, ctx: ProbeCompileContext, scope: ProbeScope): ProbeStep[] | null {
  if (ctx.platform === 'win32') return null;
  if (!command || command.length > MAX_COMMAND_LENGTH || command.includes('\0') || command.includes('\u0001')) return null;
  const loop = compileReadOnlyFileLoop(command, ctx.homeDir);
  if (loop) {
    const prefix = loop.prefix ? compileReadOnlyProbePlan(loop.prefix, ctx) : undefined;
    if (loop.prefix && !prefix) return null;
    return [...prefix?.steps ?? [], { op: ';', cmd: loop, redirect: { out: 'out', err: 'err' }, program: 'file-loop', source: command,
    extraSources: [...loop.sources, ...(loop.body.some((statement) => statement.kind === 'echo' && statement.parts.some((part) => 'value' in part && part.value === 'bytes')) ? ['wc -c'] : []), ...loop.files.map((file) => `cat ${JSON.stringify(file.path)}`)],
    }];
  }
  const looped = expandLiteralForLoop(command, (text, binding) => {
    const steps = binding ? compileLoopBody(text, ctx, binding) : compileCommand(text, ctx, { loopBody: false, vars: new Map<string, string>() });
    return steps ? { steps } : null;
  });
  if (looped !== undefined) return looped;
  const tokens = tokenize(command, scope.vars, ctx.homeDir);
  if (!tokens) return null;
  const list = compileStatements(command, tokens, 0, scope);
  if (!list) return null;
  // 以 &&/|| 结尾（悬空连接符）不是合法命令
  const last = tokens[tokens.length - 1];
  if (last?.type === 'op' && last.op !== ';') return null;
  return list.steps.length > 0 ? list.steps : null;
}

/**
 * 循环体的一次迭代。绑定值不进文本的那条路，原文里留着 `"$p"`，所以另给每个步骤补一份展开后的文本
 * （循环变量按 shell 单引号规则改写，只供用户规则逐段匹配，从不进分词器）。
 */
function compileLoopBody(text: string, ctx: ProbeCompileContext, binding: LoopBodyBinding): ProbeStep[] | null {
  const vars = binding.expanded ? new Map<string, string>() : new Map([[binding.name, binding.value]]);
  const steps = compileCommand(text, ctx, { loopBody: true, vars });
  if (!steps || binding.expanded) return steps;
  // 整个双引号词就是引用（"$p"）→ '<value>'；嵌在双引号里的引用（"== $p =="）直接换成值本身，换完还是 shell 展开出的那个词。
  // 值里不会有 $、反引号、反斜杠、换行；带双引号的值（只能来自单引号词）没法原样放进双引号，那种值的嵌在里面的引用就不展开
  const whole = new RegExp(`"\\$\\{${binding.name}\\}"|"\\$${binding.name}"`, 'g');
  const embedded = new RegExp(`\\$\\{${binding.name}\\}|\\$${binding.name}(?![A-Za-z0-9_])`, 'g');
  const quoted = `'${binding.value.replaceAll("'", `'\\''`)}'`;
  const rawInsideQuotes = !binding.value.includes('"');
  const expand = (source: string): string => {
    const expanded = source.replace(whole, () => quoted);
    return rawInsideQuotes ? expanded.replace(embedded, () => binding.value) : expanded;
  };
  return steps.map((step) => ({ ...step, extraSources: [...(step.extraSources ?? []).map(expand), expand(step.source)] }));
}

/** 把 tokens[from..] 编成语句列表；在语句起点遇到 stopWords 里的裸关键字就停在它前面；编不了返回 null。 */
function compileStatements(command: string, tokens: Token[], from: number, scope: ProbeScope, stopWords?: readonly string[]): { steps: ProbeStep[]; stop: number } | null {
  const steps: ProbeStep[] = [];
  let op: ProbeStep['op'] = ';';
  let group: Token[] = [];
  const flush = (): boolean => {
    if (group.length === 0) return false;
    const pipe = group.findIndex((token) => token.type === 'pipe');
    if (pipe >= 0) {
      const left = group.slice(0, pipe);
      const right = group.slice(pipe + 1);
      if (!left.length || right.some((token) => token.type !== 'word') || right.length < 2) return false;
      const words = right.map((token) => (token as Extract<Token, { type: 'word' }>).word);
      const [head, ...args] = words;
      if (!head.bare || head.value !== 'head' || words.some((word) => word.assignName !== undefined)) return false;
      const count = args.length === 1 && /^-\d+$/.test(args[0].value) ? args[0].value.slice(1)
        : args.length === 2 && args[0].value === '-n' && /^\d+$/.test(args[1].value) ? args[1].value : undefined;
      if (count === undefined || Number(count) < 1 || Number(count) > 10000) return false;
      if (left.some((token) => token.type !== 'word' && token.type !== 'redir')) return false;
      const compiled = compileSimple(left.filter((token) => token.type === 'word').map((token) => token.word));
      if (compiled?.cmd.kind !== 'ls' && compiled?.cmd.kind !== 'version-probe') return false;
      const source = command.slice(group[0].start, group[group.length - 1].end).trim();
      const headSource = command.slice(right[0].start, right[right.length - 1].end).trim();
      const redirs = left.filter((token) => token.type === 'redir');
      steps.push({ op, cmd: { ...compiled.cmd, headLines: Number(count) }, redirect: foldRedirect(redirs), program: compiled.program, source, extraSources: [headSource] });
      group = [];
      return true;
    }
    const words: Word[] = [];
    const redirs: Extract<Token, { type: 'redir' }>[] = [];
    for (const t of group) {
      if (t.type === 'word') words.push(t.word);
      else if (t.type === 'redir') redirs.push(t);
    }
    const source = command.slice(group[0].start, group[group.length - 1].end).trim();
    group = [];
    if (words.length === 0) return false;
    const head = words[0];
    if (head.assignName !== undefined) {
      const name = head.assignName;
      if (words.length !== 1 || redirs.length > 0 || op !== ';') return false;
      if (head.value.includes(PROBE_EXIT_STATUS)) return false;
      if (RESERVED_VAR_NAMES.has(name) || /^(LD_|DYLD_|LC_)/.test(name)) return false;
      steps.push({ op, cmd: { kind: 'noop' }, redirect: { out: 'out', err: 'err' }, program: 'assign', source });
      return true;
    }
    const compiled = compileSimple(words);
    if (!compiled) return false;
    steps.push({ op, cmd: compiled.cmd, redirect: foldRedirect(redirs), program: compiled.program, source });
    return true;
  };

  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'op') {
      // 语句起点的裸关键字：if 结构的结束词，或循环体内的一层 if
      if (group.length === 0 && op === ';' && t.type === 'word' && t.word.bare && t.word.assignName === undefined) {
        const word = t.word.value;
        if (stopWords?.includes(word)) return { steps, stop: i };
        if (word === 'if' && scope.loopBody) {
          const end = compileIf(command, tokens, i, scope, steps);
          // fi 之后必须是分隔符或结尾：`fi echo x` 在 shell 里是语法错误
          if (end < 0 || (tokens[end + 1] !== undefined && tokens[end + 1].type !== 'op')) return null;
          i = end;
          continue;
        }
      }
      group.push(t);
      continue;
    }
    if (t.op === ';' && group.length === 0) {
      // 允许连续换行 / 末尾分号；`&&`/`||` 之后的换行同样被吞掉
      continue;
    }
    if (!flush()) return null;
    op = t.op;
  }
  if (group.length > 0 && !flush()) return null;
  return { steps, stop: tokens.length };
}

/**
 * `if <test>; then <只读语句>; [else <只读语句>;] fi`（只认一层，条件恰好一条 test）。
 * 压平成「条件成立才执行」的步骤：then 的语句条件成立才跑，else 的语句条件不成立才跑；执行器在带 start 的第一条处
 * 判一次条件，后面的分支语句沿用（与 shell 一致：分支里的 cd 不改变同一段的判断）。
 * 没有 else 时补一条条件不成立才跑的空步，让整段像 shell 一样以 0 结束。返回 fi 的下标；认不出返回 -1。
 */
function compileIf(command: string, tokens: Token[], at: number, scope: ProbeScope, steps: ProbeStep[]): number {
  const keywordAt = (index: number): string | undefined => {
    const token = tokens[index];
    return token?.type === 'word' && token.word.bare ? token.word.value : undefined;
  };
  const inner: ProbeScope = { loopBody: false, vars: scope.vars };
  const condition = compileStatements(command, tokens, at + 1, inner, IF_KEYWORDS);
  // 条件恰好一条 test
  if (condition?.steps.length !== 1 || keywordAt(condition.stop) !== 'then') return -1;
  const test = condition.steps[0];
  const testCommand = test.cmd;
  if (test.op !== ';' || testCommand.kind !== 'test') return -1;
  const then = compileStatements(command, tokens, condition.stop + 1, inner, IF_KEYWORDS);
  if (!then || then.steps.length === 0 || then.steps.some((step) => step.op !== ';')) return -1;
  let otherwise: ProbeStep[] = [];
  let end = then.stop;
  if (keywordAt(end) === 'else') {
    const other = compileStatements(command, tokens, end + 1, inner, IF_KEYWORDS);
    if (!other || other.steps.length === 0 || other.steps.some((step) => step.op !== ';')) return -1;
    otherwise = other.steps;
    end = other.stop;
  }
  // 分支里的 `$?` 取的是条件的退出码，而计划只知道「上一条命令的退出码」：不认
  const usesExitStatus = (step: ProbeStep): boolean => step.cmd.kind === 'echo' && step.cmd.text.includes(PROBE_EXIT_STATUS);
  if (keywordAt(end) !== 'fi' || [...then.steps, ...otherwise].some(usesExitStatus)) return -1;
  const guard = (step: ProbeStep, negate: boolean, start = false): ProbeStep => ({
    op: ';', cmd: { kind: 'when', test: testCommand, negate, start, cmd: step.cmd }, redirect: step.redirect, program: step.program, source: step.source,
    extraSources: [test.source, ...step.extraSources ?? []],
  });
  // start 只落在一段 if 的第一条语句上：执行器在那里判一次条件，后面的分支语句沿用
  steps.push(...then.steps.map((step, index) => guard(step, false, index === 0)));
  steps.push(...(otherwise.length > 0 ? otherwise.map((step) => guard(step, true))
    : [guard({ op: ';', cmd: { kind: 'noop' }, redirect: { out: 'out', err: 'err' }, program: 'test', source: test.source }, true)]));
  return end;
}
