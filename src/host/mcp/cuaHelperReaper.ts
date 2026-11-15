// ============================================================================
// cua helper daemon reaper
// ============================================================================
// cua 的 serve 守护进程由 launcher 经 LaunchServices (`open -n -g`) 拉起，父进程是
// launchd，不是 MCP 连接的子进程——Neo 全退后它会继续活几小时。本模块在
// (1) 停机序列末尾 (2) web MCP 初始化之前各收一次：
//   - 只认命令行含 `<解析出的 helper 二进制> serve ` 的进程；路径回退成裸 `cua-driver`
//     时什么都不碰（避免误杀上游 CuaDriver），并留痕 helper_path_unresolved。
//   - 共享规则：还有别的 `<helper> mcp --socket <同 socket>` 代理活着 ⇒ 保留。
//     停机时本服务器自己刚断开的 MCP pid 不算。
//   - 启动时只收「零代理且已运行 >= 60s」的，避免与另一个正在拉起的服务器赛跑。
//   - 整棵进程树 SIGTERM。
// 每个分支都留一行日志：cua.reap daemons=<n> killed=<n> kept=<n> failed=<n> + 逐项原因。
// ============================================================================

import { execFile } from 'child_process';

const STARTUP_MIN_AGE_SEC = 60;
const PS_TIMEOUT_MS = 1_500;
const SETTLE_MAX_MS = 300;
const SETTLE_POLL_MS = 30;

export interface CuaReapDeps {
  platform: NodeJS.Platform;
  /** 返回 `ps -axo pid=,ppid=,etime=,command=` 的原始输出 */
  ps: () => Promise<string>;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  resolveDriverPath: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
}

export interface CuaReapOptions {
  phase: 'shutdown' | 'startup';
  /** 本服务器自己刚断开的 MCP 代理 pid，不计入「别人在用」 */
  ownProxyPids?: number[];
  log?: (msg: string) => void;
  deps?: Partial<CuaReapDeps>;
}

interface PsRow {
  pid: number;
  ppid: number;
  ageSec: number;
  command: string;
}

const defaultDeps: CuaReapDeps = {
  platform: process.platform,
  ps: () =>
    new Promise<string>((resolve, reject) => {
      execFile(
        '/bin/ps',
        ['-axww', '-o', 'pid=,ppid=,etime=,command='],
        { timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    }),
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  resolveDriverPath: async () => {
    const { resolveCuaDriverPath } = await import('./mcpDefaultServers');
    return resolveCuaDriverPath();
  },
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()),
};

/** etime 格式：[[dd-]hh:]mm:ss */
function parseEtimeSec(etime: string): number {
  const [dayPart, rest] = etime.includes('-') ? etime.split('-') : ['0', etime];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return Number(dayPart) * 86400 + h * 3600 + m * 60 + s;
}

function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), ageSec: parseEtimeSec(m[3]), command: m[4] });
  }
  return rows;
}

function socketOf(command: string): string | null {
  return /--socket\s+(\S+)/.exec(command)?.[1] ?? null;
}

function collectTree(rootPid: number, rows: PsRow[]): number[] {
  const out = [rootPid];
  for (let i = 0; i < out.length; i++) {
    for (const row of rows) {
      if (row.ppid === out[i] && !out.includes(row.pid)) out.push(row.pid);
    }
  }
  return out;
}

function isAlive(kill: CuaReapDeps['kill'], pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function reapCuaHelperDaemons(opts: CuaReapOptions): Promise<void> {
  const deps: CuaReapDeps = { ...defaultDeps, ...opts.deps };
  const log = opts.log ?? console.log;
  if (deps.platform !== 'darwin') return;
  const tag = `[${opts.phase}] cua.reap`;
  try {
    const driver = await deps.resolveDriverPath();
    if (!driver?.includes('/')) {
      log(`${tag} daemons=0 killed=0 kept=0 failed=0 helper_path_unresolved`);
      return;
    }
    const rows = parsePs(await deps.ps());
    const own = new Set(opts.ownProxyPids ?? []);
    const serveRows = rows.filter((r) => r.command.includes(`${driver} serve `));
    const servePids = new Set(serveRows.map((r) => r.pid));
    // 真实形状：daemon 自带带 --cua-internal-gate-* 的 serve 子进程，属于父 daemon 的树，不单独计数
    const daemons = serveRows.filter((r) => !servePids.has(r.ppid));
    // 各 dev 槽各带一份 helper（路径不同）但共用同一 socket ⇒ 代理按 socket 认，不限本机解析出的路径
    const proxies = rows.filter((r) => /cua-driver mcp /.test(r.command) && !own.has(r.pid));

    let killed = 0;
    let kept = 0;
    let failed = 0;
    const items: string[] = [];
    const killedPids: number[] = [];
    for (const d of daemons) {
      const sock = socketOf(d.command);
      const sharing = proxies.filter((p) => sock !== null && socketOf(p.command) === sock).length;
      if (sharing > 0) {
        kept += 1;
        items.push(`pid=${d.pid}:kept(shared_by_${sharing}_proxy)`);
        continue;
      }
      if (opts.phase === 'startup' && d.ageSec < STARTUP_MIN_AGE_SEC) {
        kept += 1;
        items.push(`pid=${d.pid}:kept(younger_than_${STARTUP_MIN_AGE_SEC}s)`);
        continue;
      }
      let firstError: string | null = null;
      for (const pid of collectTree(d.pid, rows)) {
        try {
          deps.kill(pid, 'SIGTERM');
          killedPids.push(pid);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? 'ERR';
          if (code !== 'ESRCH') firstError ??= code;
        }
      }
      if (firstError) {
        failed += 1;
        items.push(`pid=${d.pid}:failed(${firstError})`);
      } else {
        killed += 1;
        items.push(`pid=${d.pid}:killed`);
      }
    }
    // 短暂等待收尸，只用于让日志/调用方看到真实结果，上限 SETTLE_MAX_MS
    for (let waited = 0; waited < SETTLE_MAX_MS && killedPids.some((p) => isAlive(deps.kill, p)); waited += SETTLE_POLL_MS) {
      await deps.sleep(SETTLE_POLL_MS);
    }
    log(`${tag} daemons=${daemons.length} killed=${killed} kept=${kept} failed=${failed}${items.length ? ` ${items.join(' ')}` : ''}`);
  } catch (error) {
    log(`${tag} daemons=0 killed=0 kept=0 failed=0 error(${(error as Error).message})`);
  }
}
