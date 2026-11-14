// ============================================================================
// ReadOnlyProbePlan 执行器 — 进程内执行，不起 shell、不起解释器。
//
// - fs 调用 + 固定二进制（ls / xattr / id / whoami）的 execFile，环境变量白名单清洗。
// - 每个路径操作数在**执行时**重新做授权：敏感凭据 → 否；工作区内（realpath 仍在 root 内）、
//   或在本会话更早的用户消息里逐字出现、或是本会话附件本体/其所在目录 → 是；其余一律 abort。
// - 任何不确定（路径未授权、未知 errno、二进制缺失、输出过大）都 abort → 调用方走原审批卡。
//   plan 里全是只读步骤，abort 不会留下副作用。
// ============================================================================

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isSensitiveCredentialPath } from '../sandbox/sensitivePaths';
import type { ProbeCommand, ProbeRedirect, PyExpr, PyStmt, ReadOnlyProbePlan } from './readOnlyProbePlan';

export interface ProbeAuthority {
  workingDirectory: string;
  workspaceRoot?: string;
  /** 本会话更早的用户消息原文（路径逐字出现即视为用户点名）。 */
  userTexts: string[];
  /** 本会话附件的本体路径。 */
  attachmentPaths: string[];
  homeDir: string;
}

export interface ProbeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

class ProbeAbort extends Error {}

const MAX_OUTPUT_CHARS = 256 * 1024;
const EXEC_TIMEOUT_MS = 5000;
const SHELL_BUILTINS = new Set(['echo', 'printf', 'test', 'command', 'cd', 'pwd', 'type', 'read', 'true', 'false', 'export', 'unset', 'set', 'exit']);
const FIXED_BINARIES = { ls: '/bin/ls', xattr: '/usr/bin/xattr', id: '/usr/bin/id', whoami: '/usr/bin/whoami' } as const;

// ----------------------------------------------------------------------------
// 路径授权
// ----------------------------------------------------------------------------

function realpathOfPrefix(abs: string): string {
  let current = abs;
  const rest: string[] = [];
  for (let guard = 0; guard < 64; guard++) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      rest.push(path.basename(current));
      current = parent;
    }
  }
  return abs;
}

function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeRealpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

function isSensitive(p: string, auth: ProbeAuthority): boolean {
  const homes = new Set([auth.homeDir, safeRealpath(auth.homeDir)]);
  const roots = [auth.workspaceRoot ?? auth.workingDirectory];
  return [...homes].some((homeDir) => roots.some((projectRoot) => isSensitiveCredentialPath(p, { homeDir, projectRoot })));
}

function namedVerbatim(candidates: string[], texts: string[]): boolean {
  for (const candidate of candidates) {
    if (candidate.length < 2) continue;
    for (const text of texts) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(candidate, from);
        if (at < 0) break;
        const before = at === 0 ? '' : text[at - 1];
        const after = text.slice(at + candidate.length, at + candidate.length + 2);
        const beforeOk = before === '' || !/[A-Za-z0-9_./~-]/.test(before);
        const afterOk = after === '' || (!/^[A-Za-z0-9_/-]/.test(after) && !/^\.[A-Za-z0-9_]/.test(after));
        if (beforeOk && afterOk) return true;
        from = at + 1;
      }
    }
  }
  return false;
}

/** 返回规范化绝对路径；未授权返回 null。 */
export function authorizeProbePath(raw: string, auth: ProbeAuthority): string | null {
  if (!raw || raw.includes('\0')) return null;
  const abs = path.resolve(auth.workingDirectory, raw);
  const real = realpathOfPrefix(abs);
  if (isSensitive(abs, auth) || isSensitive(real, auth)) return null;

  const roots = [auth.workingDirectory, auth.workspaceRoot]
    .filter((r): r is string => Boolean(r) && path.resolve(r as string) !== path.parse(path.resolve(r as string)).root);
  if (roots.some((root) => isInside(abs, path.resolve(root)) && isInside(real, safeRealpath(path.resolve(root))))) return abs;

  const homeForm = isInside(abs, auth.homeDir) ? `~${abs.slice(auth.homeDir.length)}` : null;
  const named = [abs, path.isAbsolute(raw) ? raw : null, homeForm].filter((c): c is string => Boolean(c));
  if (namedVerbatim(named, auth.userTexts)) return abs;

  const attachments = auth.attachmentPaths.map((p) => path.resolve(p));
  if (attachments.some((a) => a === abs || path.dirname(a) === abs)) return abs;
  return null;
}

// ----------------------------------------------------------------------------
// Python repr / 值
// ----------------------------------------------------------------------------

class PyException {
  constructor(readonly message: string) {}
}
type PyValue = string | boolean | string[] | PyException;

function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === quote || ch === '\\') out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else if (cp > 0x7f && /[\p{C}\p{Z}]/u.test(ch)) {
      out += cp <= 0xff ? `\\x${cp.toString(16).padStart(2, '0')}`
        : cp <= 0xffff ? `\\u${cp.toString(16).padStart(4, '0')}`
          : `\\U${cp.toString(16).padStart(8, '0')}`;
    } else out += ch;
  }
  return out + quote;
}

function pyStr(v: PyValue): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v instanceof PyException) return v.message;
  return `[${v.map(pyRepr).join(', ')}]`;
}

function pyDirname(p: string): string {
  const i = p.lastIndexOf('/') + 1;
  let head = p.slice(0, i);
  if (head && head !== '/'.repeat(head.length)) head = head.replace(/\/+$/, '');
  return head;
}

const ERRNO_TEXT: Record<string, [number, string]> = {
  ENOENT: [2, 'No such file or directory'],
  ENOTDIR: [20, 'Not a directory'],
  EACCES: [13, 'Permission denied'],
};

// ----------------------------------------------------------------------------
// 执行
// ----------------------------------------------------------------------------

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const key of ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'LOGNAME']) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

function runFixed(bin: string, args: string[], cwd: string): Promise<ProbeRunResult> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, env: scrubbedEnv(), timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_CHARS, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && typeof (err as { code?: unknown }).code !== 'number') { reject(new ProbeAbort(`exec ${path.basename(bin)} failed`)); return; }
      resolve({ stdout, stderr, exitCode: err ? (err as unknown as { code: number }).code : 0 });
    });
  });
}

function lookupOnPath(name: string): string | null {
  const dirs = [...(process.env.PATH ?? '').split(':'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin'];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    } catch { /* next */ }
  }
  return null;
}

class Runner {
  stdout = '';
  stderr = '';
  constructor(private readonly auth: ProbeAuthority) {}

  private need(raw: string): string {
    const abs = authorizeProbePath(raw, this.auth);
    if (abs === null) throw new ProbeAbort('path not authorized');
    return abs;
  }

  emit(redirect: ProbeRedirect, out: string, err: string): void {
    const put = (target: ProbeRedirect['out'], text: string): void => {
      if (!text || target === 'null') return;
      if (target === 'out') this.stdout += text; else this.stderr += text;
    };
    // 外部程序接管道时 stdout 全缓冲到退出才刷出、stderr 即写即出：合流（2>&1）时 stderr 在前
    put(redirect.err, err);
    put(redirect.out, out);
    if (this.stdout.length + this.stderr.length > MAX_OUTPUT_CHARS) throw new ProbeAbort('output too large');
  }

  async run(cmd: ProbeCommand, redirect: ProbeRedirect): Promise<number> {
    switch (cmd.kind) {
      case 'noop': return 0;
      case 'test': {
        const abs = this.need(cmd.path);
        let ok: boolean;
        try {
          const st = fs.statSync(abs);
          ok = cmd.flag === '-e' ? true : cmd.flag === '-f' ? st.isFile() : st.isDirectory();
        } catch {
          ok = false;
        }
        return ok ? 0 : 1;
      }
      case 'echo': this.emit(redirect, cmd.text + (cmd.newline ? '\n' : ''), ''); return 0;
      case 'printf': this.emit(redirect, cmd.text, ''); return 0;
      case 'command-v': {
        if (SHELL_BUILTINS.has(cmd.name)) { this.emit(redirect, `${cmd.name}\n`, ''); return 0; }
        const found = lookupOnPath(cmd.name);
        if (found) { this.emit(redirect, `${found}\n`, ''); return 0; }
        return 1;
      }
      case 'ls': {
        const targets = cmd.paths.length > 0 ? cmd.paths : ['.'];
        for (const p of targets) this.need(p);
        const res = await runFixed(FIXED_BINARIES.ls, [...cmd.flags, '--', ...cmd.paths], this.auth.workingDirectory);
        this.emit(redirect, res.stdout, res.stderr);
        return res.exitCode;
      }
      case 'xattr': {
        if (process.platform !== 'darwin') throw new ProbeAbort('xattr unavailable');
        for (const p of cmd.paths) this.need(p);
        const res = await runFixed(FIXED_BINARIES.xattr, ['-l', ...cmd.paths], this.auth.workingDirectory);
        this.emit(redirect, res.stdout, res.stderr);
        return res.exitCode;
      }
      case 'id-un': {
        const res = await runFixed(FIXED_BINARIES.id, ['-un'], this.auth.workingDirectory);
        this.emit(redirect, res.stdout, res.stderr);
        return res.exitCode;
      }
      case 'whoami': {
        const res = await runFixed(FIXED_BINARIES.whoami, [], this.auth.workingDirectory);
        this.emit(redirect, res.stdout, res.stderr);
        return res.exitCode;
      }
      case 'python': {
        this.execPy(cmd.program, new Map(), redirect);
        return 0;
      }
    }
  }

  private evalPy(e: PyExpr, env: Map<string, PyValue>): PyValue {
    if (e.t === 'str') return e.v;
    if (e.t === 'name') {
      const v = env.get(e.n);
      if (v === undefined) throw new ProbeAbort('python name unbound');
      return v;
    }
    const arg = this.evalPy(e.arg, env);
    if (typeof arg !== 'string') throw new ProbeAbort('python arg type');
    if (e.fn === 'dirname') return pyDirname(arg);
    const abs = this.need(arg);
    if (e.fn === 'exists') { try { fs.statSync(abs); return true; } catch { return false; } }
    if (e.fn === 'isdir') { try { return fs.statSync(abs).isDirectory(); } catch { return false; } }
    // listdir：用 opendir 保持与 python os.listdir 相同的 readdir 原生顺序
    try {
      const dir = fs.opendirSync(abs);
      const names: string[] = [];
      try {
        for (let ent = dir.readSync(); ent; ent = dir.readSync()) {
          if (ent.name.includes('�')) throw new ProbeAbort('non-utf8 name');
          names.push(ent.name);
          if (names.length > 5000) throw new ProbeAbort('listing too large');
        }
      } finally { dir.closeSync(); }
      return names;
    } catch (err) {
      if (err instanceof ProbeAbort) throw err;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const known = ERRNO_TEXT[code];
      if (!known) throw new ProbeAbort(`unexpected errno ${code}`);
      throw new PyException(`[Errno ${known[0]}] ${known[1]}: ${pyRepr(arg)}`);
    }
  }

  private execPy(stmts: PyStmt[], env: Map<string, PyValue>, redirect: ProbeRedirect): void {
    for (const s of stmts) {
      switch (s.t) {
        case 'import': break;
        case 'assign': env.set(s.n, this.evalPy(s.e, env)); break;
        case 'print':
          this.emit(redirect, `${s.args.map((a) => pyStr(this.evalPy(a, env))).join(' ')}\n`, '');
          break;
        case 'try':
          try {
            this.execPy(s.body, env, redirect);
          } catch (err) {
            if (!(err instanceof PyException)) throw err;
            if (s.excName) env.set(s.excName, err);
            this.execPy(s.handler, env, redirect);
            if (s.excName) env.delete(s.excName);
          }
          break;
      }
    }
  }
}

/** 执行计划；任何不确定返回 null（调用方走原审批链）。 */
export async function executeReadOnlyProbePlan(plan: ReadOnlyProbePlan, auth: ProbeAuthority): Promise<ProbeRunResult | null> {
  const runner = new Runner({ ...auth, homeDir: auth.homeDir || os.homedir() });
  let status = 0;
  try {
    for (const step of plan.steps) {
      if (step.op === '&&' && status !== 0) continue;
      if (step.op === '||' && status === 0) continue;
      status = await runner.run(step.cmd, step.redirect);
    }
  } catch {
    // PyException 逃出 try 块 = 脚本会以 traceback 退出；ProbeAbort = 无法证明。其余意外同样交回审批链。
    return null;
  }
  return { stdout: runner.stdout, stderr: runner.stderr, exitCode: status };
}
