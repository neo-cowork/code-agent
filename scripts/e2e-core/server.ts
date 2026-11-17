import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DbSnapshot, ServerInfo } from './types';

const START_TIMEOUT_MS = 300_000;

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
