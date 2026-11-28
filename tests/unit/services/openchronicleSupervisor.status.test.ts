// ============================================================================
// openchronicleSupervisor.getStatus — 结构化「是否已安装」
// 走真 getStatus()：候选路径上没有 CLI → installed:false（保留原 lastError）；
// 在其中一个候选路径放一个可执行桩 → installed:true（resolveShim 只缓存成功结果，
// 所以同一进程里「装好后再刷新」能解锁）。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sandbox = vi.hoisted(() => ({ home: '', probed: [] as string[] }));

// 家目录指向临时目录：SHIM_PATHS / VENV_BIN 里基于家目录的两条候选路径都落在沙盒里。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => sandbox.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

// 两条系统级候选路径（/opt/homebrew/bin、/usr/local/bin）一律当作不存在，测试不依赖本机装没装；
// 沙盒内路径走真实 fs.access（含 X_OK 可执行位检查）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const access = async (target: fs.PathLike, mode?: number) => {
    const file = String(target);
    if (file.endsWith(`${path.sep}openchronicle`)) sandbox.probed.push(file);
    if (file.endsWith(`${path.sep}openchronicle`) && !file.startsWith(sandbox.home)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, access '${file}'`), { code: 'ENOENT' });
    }
    return actual.promises.access(target, mode);
  };
  const promises = { ...actual.promises, access };
  return { ...actual, promises, default: { ...actual, promises } };
});

let getStatus: typeof import('../../../src/host/services/external/openchronicleSupervisor').getStatus;

beforeAll(async () => {
  sandbox.home = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-oc-status-'));
  // MCP 健康探测不出网：连接直接被拒，探测判不健康。
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8742');
  }));
  ({ getStatus } = await import('../../../src/host/services/external/openchronicleSupervisor'));
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(sandbox.home, { recursive: true, force: true });
});

describe('openchronicleSupervisor.getStatus installed flag', () => {
  it('reports installed:false when no CLI exists on any candidate path, and keeps lastError', async () => {
    sandbox.probed = [];
    const status = await getStatus();

    expect(status).toMatchObject({ installed: false, state: 'stopped', mcpHealthy: false });
    expect(status.lastError).toBe('OpenChronicle 未安装');
    expect(sandbox.probed).toEqual([
      path.join(sandbox.home, '.local', 'bin', 'openchronicle'),
      '/opt/homebrew/bin/openchronicle',
      '/usr/local/bin/openchronicle',
      path.join(sandbox.home, '.openchronicle', 'venv', 'bin', 'openchronicle'),
    ]);
  });

  it('reports installed:true once an executable CLI stub sits on one candidate path', async () => {
    const shim = path.join(sandbox.home, '.openchronicle', 'venv', 'bin', 'openchronicle');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, '#!/bin/sh\necho "Daemon   stopped"\necho "Buffer   3 files"\necho "Memory   7 entries"\n');
    fs.chmodSync(shim, 0o755);

    const status = await getStatus();

    expect(status).toMatchObject({
      installed: true,
      state: 'stopped',
      mcpHealthy: false,
      bufferFiles: 3,
      memoryEntries: 7,
    });
    expect(status.lastError).toBeUndefined();
  });
});
