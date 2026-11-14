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

export type ProbeStream = 'out' | 'err' | 'null';

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
  | { kind: 'noop' }
  | { kind: 'test'; flag: '-e' | '-f' | '-d'; path: string }
  | { kind: 'echo'; text: string; newline: boolean }
  | { kind: 'printf'; text: string }
  | { kind: 'command-v'; name: string }
  | { kind: 'ls'; flags: string[]; paths: string[] }
  | { kind: 'xattr'; paths: string[] }
  | { kind: 'id-un' }
  | { kind: 'whoami' }
  | { kind: 'python'; program: PyStmt[] };

export interface ProbeStep {
  /** 与前一步的连接符；第一步恒为 ';'。 */
  op: ';' | '&&' | '||';
  cmd: ProbeCommand;
  redirect: ProbeRedirect;
  /** 该步的程序名（日志只记程序名，不记路径/内容）。 */
  program: string;
  /** 该步对应的原文片段，供用户规则逐段匹配。 */
  source: string;
}

export interface ReadOnlyProbePlan {
  steps: ProbeStep[];
}

const RESERVED_VAR_NAMES = new Set([
  'PATH', 'IFS', 'HOME', 'SHELL', 'CDPATH', 'PWD', 'OLDPWD', 'ENV', 'BASH_ENV', 'TZ', 'LANG', 'USER', 'LOGNAME',
]);
const LS_FLAG_CHARS = 'lahAFdtrSpOi@e1ns';
const MAX_COMMAND_LENGTH = 8000;

interface Word {
  value: string;
  /** 来自纯字面（无引号、无变量展开）。程序名必须是纯字面。 */
  bare: boolean;
  assignName?: string;
}
type Token =
  | { type: 'word'; word: Word; start: number; end: number }
  | { type: 'op'; op: ';' | '&&' | '||'; start: number; end: number }
  | { type: 'redir'; fd: 1 | 2; target: 'null' | 1 | 2; start: number; end: number };

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNQUOTED_FORBIDDEN = new Set(['$', '`', '\\', '(', ')', '{', '}', '*', '?', '[', ']', '<', '>', '|', '&', '!', '#', '"', "'"]);

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t';
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
  switch (program) {
    case 'test': {
      if (argv.length !== 2 || !['-e', '-f', '-d'].includes(argv[0]) || argv[1] === '') return null;
      return { program, cmd: { kind: 'test', flag: argv[0] as '-e' | '-f' | '-d', path: argv[1] } };
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
      if (argv.length !== 2 || argv[0] !== '-v' || !/^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/.test(argv[1])) return null;
      return { program, cmd: { kind: 'command-v', name: argv[1] } };
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
      if (argv.length !== 2 || argv[0] !== '-c') return null;
      const program2 = compilePython(argv[1]);
      return program2 ? { program, cmd: { kind: 'python', program: program2 } } : null;
    }
    default:
      return null;
  }
}

export interface ProbeCompileContext {
  homeDir: string;
  platform: NodeJS.Platform;
}

/** 编译；任何一处不能证明只读就返回 null（调用方原样走审批）。 */
export function compileReadOnlyProbePlan(command: string, ctx: ProbeCompileContext): ReadOnlyProbePlan | null {
  if (ctx.platform === 'win32') return null;
  if (!command || command.length > MAX_COMMAND_LENGTH || command.includes('\0')) return null;
  const tokens = tokenize(command, new Map(), ctx.homeDir);
  if (!tokens) return null;

  const steps: ProbeStep[] = [];
  let op: ProbeStep['op'] = ';';
  let group: Token[] = [];
  const flush = (): boolean => {
    if (group.length === 0) return false;
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
      if (RESERVED_VAR_NAMES.has(name) || /^(LD_|DYLD_|LC_)/.test(name)) return false;
      steps.push({ op, cmd: { kind: 'noop' }, redirect: { out: 'out', err: 'err' }, program: 'assign', source });
      return true;
    }
    const compiled = compileSimple(words);
    if (!compiled) return false;
    steps.push({ op, cmd: compiled.cmd, redirect: foldRedirect(redirs), program: compiled.program, source });
    return true;
  };

  for (const t of tokens) {
    if (t.type !== 'op') { group.push(t); continue; }
    if (t.op === ';' && group.length === 0) {
      // 允许连续换行 / 末尾分号；`&&`/`||` 之后的换行同样被吞掉
      continue;
    }
    if (!flush()) return null;
    op = t.op;
  }
  if (group.length > 0 && !flush()) return null;
  // 以 &&/|| 结尾（悬空连接符）不是合法命令
  if (tokens.length > 0 && tokens[tokens.length - 1].type === 'op' && (tokens[tokens.length - 1] as { op: string }).op !== ';') return null;
  return steps.length > 0 ? { steps } : null;
}
