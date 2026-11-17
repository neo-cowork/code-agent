// Launch / reclaim helpers for desktop-shell-packaged-smoke.
// 红线：禁止直接 exec *.app/Contents/MacOS/*（沙箱里 AppKit 拿不到 WindowServer 会 abort）。
// 启动只走 LaunchServices（open）；只「读」进程命令行（ps），绝不执行 bundle 内二进制。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const OPEN_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 1000;

export function buildOpenArgv(appPath, dataDir, port) {
  return [
    '-n', '-g', '-j',
    '--env', 'NEO_VERIFY_NO_FOREGROUND=1',
    '--env', `CODE_AGENT_DATA_DIR=${dataDir}`,
    '--env', `CODE_AGENT_WEB_PORT=${port}`,
    '--env', `WEB_PORT=${port}`,
    appPath,
  ];
}

// pids whose command line starts with <appPath>/Contents/MacOS/ (read-only via ps).
export function listAppPids(appPath) {
  const prefix = `${path.join(appPath, 'Contents', 'MacOS')}${path.sep}`;
  let out;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return new Set();
  }
  const pids = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m && m[2].startsWith(prefix)) pids.add(Number(m[1]));
  }
  return pids;
}

export function listPortListeners(port) {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return out.split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

export function launchApp(appPath, dataDir, port) {
  if (process.platform !== 'darwin') {
    throw new Error('desktop-shell packaged smoke can only launch a .app on macOS');
  }
  if (!fs.existsSync(appPath)) {
    throw new Error(`Packaged app not found: ${appPath}`);
  }
  const preexistingPids = listAppPids(appPath);
  const openArgv = ['open', ...buildOpenArgv(appPath, dataDir, port)];
  const res = spawnSync(openArgv[0], openArgv.slice(1), { encoding: 'utf8', timeout: OPEN_TIMEOUT_MS });
  const launch = {
    openArgv,
    openExitCode: res.status,
    ...(res.error ? { openError: res.error.message } : {}),
    ...(res.stderr ? { openStderr: String(res.stderr).slice(-2000) } : {}),
  };
  if (res.error || res.status !== 0) {
    throw new Error(`open failed (exit ${res.status ?? 'null'}): ${res.error?.message ?? String(res.stderr || '').trim()}`);
  }
  return { appPath, port, preexistingPids, launch };
}

// 只回收「启动后新增的同 bundle 进程」+「LISTEN 在冒烟端口上的进程」；按 pid 集合差，不按进程名。
export async function reclaimLaunchedApp(launched) {
  const current = listAppPids(launched.appPath);
  const targets = new Set([...current].filter((pid) => !launched.preexistingPids.has(pid)));
  for (const pid of listPortListeners(launched.port)) {
    if (!launched.preexistingPids.has(pid)) targets.add(pid);
  }
  targets.delete(process.pid);
  const send = (sig) => {
    for (const pid of targets) {
      try { process.kill(pid, sig); } catch { /* already gone */ }
    }
  };
  send('SIGTERM');
  if (targets.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
    send('SIGKILL');
  }
  return [...targets];
}
