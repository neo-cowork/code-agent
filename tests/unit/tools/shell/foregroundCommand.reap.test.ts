import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../../src/host/protocol/tools';
import { runForegroundCommand } from '../../../../src/host/tools/modules/shell/foregroundCommand';
import { reapChildProcesses } from '../../../../src/host/tools/shell/shutdownReaper';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function makeToolContext(workingDirectory: string): ToolContext {
  return {
    sessionId: 'session-fg-reap',
    workingDirectory,
    requestPermission: async () => true,
    emit: () => {},
  } as unknown as ToolContext;
}

describePosix('foregroundCommand 停机整组收树（真进程）', () => {
  const tempDirs: string[] = [];
  const spawnedPids: number[] = [];

  afterEach(async () => {
    await reapChildProcesses('test_cleanup');
    for (const pid of spawnedPids.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reapChildProcesses 收掉仍在跑的前台命令及其孙进程（即使未走 abortSignal）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'neo-fg-reap-live-'));
    tempDirs.push(cwd);
    const pidFile = join(cwd, 'grandchild.pid');
    const abortController = new AbortController();

    const running = runForegroundCommand({
      command: `sh -c 'sleep 120 & echo $! > "${pidFile}"; wait'`,
      cwd,
      timeout: 30_000,
      env: { ...process.env },
      abortSignal: abortController.signal,
      ctx: makeToolContext(cwd),
      toolName: 'Bash',
      startedAt: Date.now(),
    });

    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf-8').trim().length > 0);
    const grandchildPid = Number(readFileSync(pidFile, 'utf-8').trim());
    spawnedPids.push(grandchildPid);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(pidAlive(grandchildPid)).toBe(true);

    const { killedForegroundCommands } = await reapChildProcesses('test_shutdown');

    expect(killedForegroundCommands).toBeGreaterThanOrEqual(1);
    expect(pidAlive(grandchildPid)).toBe(false);
    await expect(running).rejects.toThrow(/aborted/);
  }, 20_000);

  it('直接 shell 已退出但进程组里残留 nohup/& 后台孙进程时，reapChildProcesses 仍整组收干净', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'neo-fg-reap-nohup-'));
    tempDirs.push(cwd);
    const pidFile = join(cwd, 'detached-grandchild.pid');
    const abortController = new AbortController();

    const result = await runForegroundCommand({
      command: `nohup sleep 120 >/dev/null 2>&1 & echo $! > "${pidFile}"`,
      cwd,
      timeout: 10_000,
      env: { ...process.env },
      abortSignal: abortController.signal,
      ctx: makeToolContext(cwd),
      toolName: 'Bash',
      startedAt: Date.now(),
    });
    expect(result.stderr).toBe('');

    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf-8').trim().length > 0);
    const grandchildPid = Number(readFileSync(pidFile, 'utf-8').trim());
    spawnedPids.push(grandchildPid);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(pidAlive(grandchildPid)).toBe(true);

    const { killedForegroundCommands } = await reapChildProcesses('test_shutdown');

    expect(killedForegroundCommands).toBeGreaterThanOrEqual(1);
    expect(pidAlive(grandchildPid)).toBe(false);
  }, 20_000);
});

describe('Foreground 命令收尸接线守护', () => {
  it('reapChildProcesses 收前台命令，且 webServer 停机日志记录 foreground command(s)', () => {
    const root = join(__dirname, '../../../../src');
    const reaper = readFileSync(join(root, 'host/tools/shell/shutdownReaper.ts'), 'utf-8');
    expect(reaper).toContain('reapForegroundCommands');
    expect(reaper).toContain('killedForegroundCommands');

    const webServer = readFileSync(join(root, 'web/webServer.ts'), 'utf-8');
    expect(webServer).toContain('foreground command(s)');
  });
});
