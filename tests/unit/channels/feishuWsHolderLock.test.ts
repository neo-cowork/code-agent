import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelManager } from '../../../src/host/channels/channelManager';
import type { ChannelAccount } from '../../../src/shared/contract/channel';

type WsHandlers = {
  onReady?: () => void;
  onError?: (err: Error) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
};

const wsCaptures = vi.hoisted(() => ({
  ctor: [] as WsHandlers[],
}));

const warnLogs = vi.hoisted(() => [] as Array<{ message: string; meta: unknown }>);

vi.mock('../../../src/host/services/infra/logger', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/infra/logger')>(
    '../../../src/host/services/infra/logger',
  );
  return {
    ...actual,
    createLogger: (context: string, options?: Parameters<typeof actual.createLogger>[1]) => {
      const created = actual.createLogger(context, options);
      if (context === 'FeishuChannel') {
        const originalWarn = created.warn.bind(created);
        created.warn = ((message: string, meta?: unknown, ...rest: unknown[]) => {
          warnLogs.push({ message, meta });
          originalWarn(message, meta as never, ...rest);
        }) as typeof created.warn;
      }
      return created;
    },
  };
});

vi.mock('@larksuiteoapi/node-sdk', async () => {
  const actual = await vi.importActual<typeof import('@larksuiteoapi/node-sdk')>(
    '@larksuiteoapi/node-sdk',
  );
  class WSClient {
    close = vi.fn();
    constructor(opts: WsHandlers) {
      wsCaptures.ctor.push(opts);
    }
    start = vi.fn(async (opts: WsHandlers) => {
      opts.onReady?.();
    });
  }
  return { ...actual, WSClient };
});

function lockFileForAppId(tmpDir: string, appId: string): string {
  const hash = createHash('sha256').update(appId).digest('hex').slice(0, 16);
  return path.join(tmpDir, `neo-feishu-ws-holder-${hash}.lock.json`);
}

describe('Feishu WS local multi-instance holder lock', () => {
  const originalTmpDir = process.env.TMPDIR;
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
  let tempRoot = '';
  const createdIds: string[] = [];
  const childProcesses: ChildProcess[] = [];

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'neo-feishu-holder-test-'));
    process.env.TMPDIR = tempRoot;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempRoot, 'parent-data');
    wsCaptures.ctor.length = 0;
    warnLogs.length = 0;
  });

  afterEach(async () => {
    const manager = ChannelManager.getInstance();
    for (const accountId of createdIds.splice(0)) {
      await manager.disconnectAccount(accountId);
      await manager.deleteAccount(accountId);
    }
    for (const child of childProcesses.splice(0)) {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    }
    if (originalTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpDir;
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    if (tempRoot && existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('① detects another live local process holding the lock, sets feishuSharedAppDetected=true, and logs a warn with child pid and dataDir', async () => {
    const appId = 'cli_real_two_proc_test';
    const childDataDir = path.join(tempRoot, 'child-slot-data');
    const lockModuleUrl = new URL('../../../src/host/channels/feishu/feishuWsHolderLock.ts', import.meta.url).href;

    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `import { claimFeishuWsHolderLock } from ${JSON.stringify(lockModuleUrl)};
         claimFeishuWsHolderLock(${JSON.stringify(appId)});
         process.stdout.write('LOCKED\\n');
         setInterval(() => {}, 1000);`,
      ],
      {
        env: {
          ...process.env,
          TMPDIR: tempRoot,
          TMP: tempRoot,
          TEMP: tempRoot,
          CODE_AGENT_DATA_DIR: childDataDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    childProcesses.push(child);

    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.includes('LOCKED')) resolve();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('exit', (code) => {
        reject(new Error(`Child exited early (${code}): ${stderr}`));
      });
    });

    expect(child.pid).toBeDefined();
    const manager = ChannelManager.getInstance();
    const account = await manager.addAccount('Feishu Prod', 'feishu', {
      type: 'feishu',
      appId,
      appSecret: 'secret- never-in-lock',
      useWebSocket: true,
    });
    createdIds.push(account.id);

    const seenFlags: Array<boolean | undefined> = [];
    const onChanged = (accounts: ChannelAccount[]) => {
      seenFlags.push(accounts.find((item) => item.id === account.id)?.feishuSharedAppDetected);
    };
    manager.on('accounts_changed', onChanged);
    try {
      await manager.connectAccount(account.id);
    } finally {
      manager.off('accounts_changed', onChanged);
    }

    expect(manager.getAccount(account.id)?.feishuSharedAppDetected).toBe(true);
    expect(seenFlags).toContain(true);

    const matchingWarns = warnLogs.filter((entry) =>
      entry.message.includes('Another local Neo process holds a Feishu WebSocket connection'),
    );
    expect(matchingWarns).toHaveLength(1);
    expect(matchingWarns[0]?.meta).toMatchObject({
      otherPid: child.pid,
      otherDataDir: childDataDir,
    });

    const lockContent = readFileSync(lockFileForAppId(tempRoot, appId), 'utf8');
    expect(lockContent).not.toContain('secret- never-in-lock');
  });

  it('② single instance: no existing lock or own previous lock produces no flag and no warn', async () => {
    const appId = 'cli_single_instance_test';
    const manager = ChannelManager.getInstance();
    const account = await manager.addAccount('Feishu Single', 'feishu', {
      type: 'feishu',
      appId,
      appSecret: 'secret-1',
      useWebSocket: true,
    });
    createdIds.push(account.id);

    await manager.connectAccount(account.id);
    expect(manager.getAccount(account.id)?.feishuSharedAppDetected).toBe(false);
    expect(warnLogs).toHaveLength(0);

    // Same process re-claiming its own lock (e.g. onReconnected) -> still false, no warn
    wsCaptures.ctor.at(-1)?.onReconnected?.();
    expect(manager.getAccount(account.id)?.feishuSharedAppDetected).toBe(false);
    expect(warnLogs).toHaveLength(0);
  });

  it('③ crash-left lock (exited child pid) and garbage lock file produce no flag, overwrite lock, and do not throw', async () => {
    const appId = 'cli_crash_left_test';
    const exitedChild = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = await new Promise<number>((resolve, reject) => {
      exitedChild.once('exit', () => {
        if (exitedChild.pid) resolve(exitedChild.pid);
        else reject(new Error('missing pid'));
      });
    });

    const lockPath = lockFileForAppId(tempRoot, appId);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, dataDir: '/tmp/crashed-slot', startedAt: 100 }),
      'utf8',
    );

    const manager = ChannelManager.getInstance();
    const account = await manager.addAccount('Feishu Crash', 'feishu', {
      type: 'feishu',
      appId,
      appSecret: 'secret-crash',
      useWebSocket: true,
    });
    createdIds.push(account.id);

    await manager.connectAccount(account.id);
    expect(manager.getAccount(account.id)?.feishuSharedAppDetected).toBe(false);
    expect(warnLogs).toHaveLength(0);
    const overwritten = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
    expect(overwritten.pid).toBe(process.pid);
    await manager.disconnectAccount(account.id);

    // Garbage lock file -> no flag, no throw, overwritten
    writeFileSync(lockPath, '{not-valid-json', 'utf8');
    await expect(manager.connectAccount(account.id)).resolves.toBeUndefined();
    expect(manager.getAccount(account.id)?.feishuSharedAppDetected).toBe(false);
    expect(warnLogs).toHaveLength(0);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
  });

  it('④ disconnect clears feishuSharedAppDetected and removes only our own lock (leaving another pid lock intact)', async () => {
    const appId = 'cli_disconnect_lock_test';
    const lockPath = lockFileForAppId(tempRoot, appId);
    // Seed a live pid (parent pid) so connect sees another holder first
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.ppid, dataDir: '/tmp/other-slot', startedAt: 200 }),
      'utf8',
    );

    const manager = ChannelManager.getInstance();
    const account = await manager.addAccount('Feishu Disconnect', 'feishu', {
      type: 'feishu',
      appId,
      appSecret: 'secret-2',
      useWebSocket: true,
    });
    createdIds.push(account.id);

    await manager.connectAccount(account.id);
    expect(manager.getAccount(account.id)?.feishuSharedAppDetected).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    // Disconnect when we own the lock -> clears flag and deletes lock file
    await manager.disconnectAccount(account.id);
    expect(manager.getAccount(account.id)?.feishuSharedAppDetected).toBeUndefined();
    expect(existsSync(lockPath)).toBe(false);

    // Reconnect, then simulate another pid taking the lock before our disconnect runs -> disconnect leaves it untouched
    await manager.connectAccount(account.id);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.ppid, dataDir: '/tmp/other-slot-2', startedAt: 300 }),
      'utf8',
    );
    await manager.disconnectAccount(account.id);
    expect(manager.getAccount(account.id)?.feishuSharedAppDetected).toBeUndefined();
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.ppid);
  });
});
