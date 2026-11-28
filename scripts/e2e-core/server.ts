import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DbSnapshot, ServerInfo } from './types';

const START_TIMEOUT_MS = 300_000;
const SAMPLE_SECONDS = 3;
const SAMPLE_TIMEOUT_MS = 30_000;

function findOnPath(command: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    } catch { /* 不在这一格 */ }
  }
  return null;
}

/**
 * kill9 之前给卡住的服务抓一份原生栈（macOS `sample`）：kill9 之后现场就没了。
 * 失败只记原因、不拦重启；返回采样文件路径，失败返回 null。
 */
function sampleHungServer(pid: number, serverDir: string): string | null {
  const bin = findOnPath('sample');
  if (!bin) { console.log(`sample: 跳过，PATH 里找不到 sample（pid ${pid}）`); return null; }
  const file = path.join(serverDir, `hang-sample-${pid}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const res = spawnSync(bin, [String(pid), String(SAMPLE_SECONDS), '-file', file], { encoding: 'utf8', timeout: SAMPLE_TIMEOUT_MS });
  if (res.error || res.status !== 0 || !fs.existsSync(file)) {
    const why = res.error?.message ?? (res.status !== 0 ? `退出码 ${res.status} ${String(res.stderr ?? '').trim()}` : '没有产出文件');
    console.log(`sample: pid ${pid} 采样失败，继续重启：${why}`);
    return null;
  }
  console.log(`sample saved ${file}`);
  return file;
}

/** 独立进程组里跑 neo-realrun（kill9/restart 前后 runner 曾被整组 SIGKILL，退出码 137；隔开进程组以免连累 runner）。 */
function runRealrunDetached(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`neo-realrun ${args[0]} 超时`)); }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`neo-realrun ${args[0]} 退出码 ${code}\n${out}`));
    });
  });
}

function runRealrun(bin: string, args: string[], timeoutMs = 120_000): string {
  return execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function assertRealrunBin(bin: string): void {
  if (!fs.existsSync(bin)) {
    console.error(`e2e-core: 找不到 neo-realrun（${bin}）；用环境变量 NEO_REALRUN_BIN 指向它`);
    process.exit(2);
  }
}

/**
 * neo-realrun 的服务从 <输出目录>/../renderer 读前端；我们把 dist/renderer 软链到 <out>/renderer，
 * 服务目录放在 <out>/server-<时间戳>，这样页面才有得 serve。
 */
export function startServer(bin: string, repoRoot: string, out: string): ServerInfo {
  fs.mkdirSync(out, { recursive: true });
  const link = path.join(out, 'renderer');
  fs.rmSync(link, { force: true, recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'dist/renderer'), link);
  const dir = path.join(out, `server-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  let output: string;
  try {
    output = runRealrun(bin, ['start', '--wt', repoRoot, '--out', dir], START_TIMEOUT_MS);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`neo-realrun start 失败：${err.message}\n${err.stdout ?? ''}${err.stderr ?? ''}`, { cause: e });
  }
  process.stdout.write(output.split('\n').filter((l) => l.startsWith('started ') || l.startsWith('workspace')).join('\n') + '\n');
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as Record<string, string | number>;
  return {
    port: Number(state.port), token: String(state.token), home: String(state.home), dataDir: String(state.dataDir),
    workspace: String(state.workspace), dir, model: String(state.model),
  };
}

export function stopServer(bin: string, server: ServerInfo): void {
  const state = JSON.parse(fs.readFileSync(path.join(server.dir, 'state.json'), 'utf8')) as { pid: number };
  console.log(runRealrun(bin, ['stop', '--out', server.dir]).trim());
  let alive = true;
  try { process.kill(state.pid, 0); } catch { alive = false; }
  if (alive) {
    // SIGTERM 后服务还在收尾后台任务：只对自己起的这个进程组升级到 SIGKILL，再核对
    console.log(`pid ${state.pid} 收到 SIGTERM 后仍在，升级 kill9`);
    sampleHungServer(state.pid, server.dir);
    console.log(runRealrun(bin, ['kill9', '--out', server.dir]).trim());
    try { process.kill(state.pid, 0); } catch { alive = false; }
  }
  if (alive) throw new Error(`neo-realrun stop/kill9 之后 pid ${state.pid} 仍然存活`);
  // 服务派生的语言服务器等子进程：命令行里带着本次服务目录，按它清残留
  try { execFileSync('pkill', ['-f', server.dir]); } catch { /* 没有残留 */ }
}

export function dumpDb(bin: string, server: ServerInfo): { file: string; data: DbSnapshot } {
  const out = runRealrun(bin, ['dump', '--out', server.dir]);
  const file = /db snapshot (\S+):/.exec(out)?.[1];
  if (!file) throw new Error(`解析不到 db 快照路径：${out}`);
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) as DbSnapshot };
}

/** 抓 /api/events 的原始事件流写进文件（页面用的就是这一路），用来核对 resolvedModel。 */
export function captureEvents(server: ServerInfo, file: string): () => void {
  const abort = new AbortController();
  const stream = fs.createWriteStream(file);
  void (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
        headers: { Authorization: `Bearer ${server.token}` }, signal: abort.signal,
      });
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) stream.write(chunk);
    } catch { /* 结束时 abort 属正常 */ }
    stream.end();
  })();
  return () => abort.abort();
}

function readServerPid(serverDir: string): number | null {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(serverDir, 'state.json'), 'utf8')) as { pid?: unknown };
    return typeof state.pid === 'number' && Number.isInteger(state.pid) && state.pid > 0 ? state.pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 服务崩过或卡死（进程存活但 /api/health 无响应）就用同一个数据目录和端口拉起来；返回要写进 reason 的说明，正常返回 null。 */
export async function ensureServerAlive(bin: string, server: ServerInfo): Promise<string | null> {
  const alive = await fetch(`http://127.0.0.1:${server.port}/api/health`, {
    headers: { Authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(3_000),
  }).then((r) => r.ok, () => false);
  if (alive) return null;
  const pid = readServerPid(server.dir);
  const hung = pid !== null && isPidAlive(pid);
  if (hung) {
    console.log(`ensureServerAlive: pid ${pid} alive but /api/health unresponsive, sample + kill9 + restart`);
    const sampleFile = sampleHungServer(pid, server.dir);
    try {
      const killOut = (await runRealrunDetached(bin, ['kill9', '--out', server.dir], 60_000)).trim();
      if (killOut) console.log(killOut);
      const restartOut = (await runRealrunDetached(bin, ['restart', '--out', server.dir], START_TIMEOUT_MS)).trim();
      if (restartOut) console.log(restartOut);
    } catch (e) {
      throw new Error(`服务卡死（pid ${pid} 存活但 /api/health 无响应）且 kill9 + restart 失败：${(e as Error).message}`, { cause: e });
    }
    return `服务在上一轮后卡死（pid ${pid} 存活但 /api/health 无响应），已 kill9 + restart 拉起（日志见 ${path.join(server.dir, 'server-1.log')}；${sampleFile ? `卡死时的原生栈采样见 ${sampleFile}` : '原生栈采样未取到，原因见控制台 sample: 行'}）`;
  }
  try {
    const restartOut = (await runRealrunDetached(bin, ['restart', '--out', server.dir], START_TIMEOUT_MS)).trim();
    if (restartOut) console.log(restartOut);
  } catch (e) {
    throw new Error(`服务已退出且 neo-realrun restart 失败：${(e as Error).message}`, { cause: e });
  }
  return `服务在上一轮里退出过，已用 neo-realrun restart 拉起（日志见 ${path.join(server.dir, 'server-1.log')}）`;
}

/** 一次尝试结束后停掉它留下的会话（等批准 / 后台还在跑），免得下一次尝试的页面还看见「运行中」。 */
export async function cancelSessions(server: ServerInfo, sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, abandonParked: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const rawBody = await res.text().catch(() => '');
        const body = rawBody.slice(0, 200).replace(/[\r\n]+/g, ' ').trim();
        console.warn(`cancelSessions: session ${sessionId} failed with status ${res.status}${body ? `: ${body}` : ''}`);
      }
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).replace(/[\r\n]+/g, ' ').trim();
      console.warn(`cancelSessions: session ${sessionId} request error: ${msg}`);
    }
  }
}

const IDLE_CAP_MS = 45_000;

function cleanSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return null;
  return trimmed;
}

function busySessions(data: DbSnapshot): string[] {
  const ids = new Set<string>();
  for (const s of data.sessions) {
    if (s.status !== 'running') continue;
    const id = cleanSessionId(s.id);
    if (id) ids.add(id);
  }
  for (const a of data.pendingApprovals) {
    if (String(a.status ?? 'pending') !== 'pending') continue;
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(a.payload_json ?? '{}'));
      if (!parsed || typeof parsed !== 'object') continue;
      payload = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const argsRef = payload.argsRef && typeof payload.argsRef === 'object'
      ? (payload.argsRef as Record<string, unknown>)
      : undefined;
    const id = cleanSessionId(payload.sessionId)
      ?? cleanSessionId(argsRef?.sessionId)
      ?? cleanSessionId(a.coordinator_id);
    if (id) ids.add(id);
  }
  for (const e of data.cronExecutions) {
    if (e.status !== 'running') continue;
    const id = cleanSessionId(e.session_id);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * 每次尝试前：停掉所有还在跑 / 等批准的会话，等服务回到空闲；
 * 限时内没空闲就 kill9 + restart（只对自己起的服务），返回要写进 reason 的说明。
 */
export async function quiesceServer(bin: string, server: ServerInfo): Promise<string | null> {
  const restarted = await ensureServerAlive(bin, server);
  if (restarted) return restarted;
  const deadline = Date.now() + IDLE_CAP_MS;
  let busy = busySessions(dumpDb(bin, server).data);
  while (busy.length && Date.now() < deadline) {
    console.log(`quiesce: ${busy.length} busy session(s), cancelling`);
    await cancelSessions(server, busy);
    await new Promise((r) => setTimeout(r, 3_000));
    busy = busySessions(dumpDb(bin, server).data);
  }
  if (!busy.length) return null;
  console.log('quiesce: still busy, kill9 + restart');
  await runRealrunDetached(bin, ['kill9', '--out', server.dir], 60_000);
  await runRealrunDetached(bin, ['restart', '--out', server.dir], START_TIMEOUT_MS);
  return `上一次尝试留下 ${busy.length} 个停不下来的会话，${IDLE_CAP_MS / 1000}s 内没回到空闲，已 kill9 + restart 服务`;
}
