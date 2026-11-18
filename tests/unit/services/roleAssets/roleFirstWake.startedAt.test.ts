// startedAt 从状态文件 enqueuedAt 进入快照。新文件：roleFirstWake.test.ts 已贴近 max-lines。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const harness = vi.hoisted(() => ({ configDir: '', seq: 0 }));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => harness.configDir,
  getAgentsMdDir: () => ({ user: path.join(harness.configDir, 'agents') }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getCurrentSessionId: () => null,
    getSession: async () => null,
    createSession: async () => ({ id: `started-${++harness.seq}` }),
  }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({}) }),
}));
vi.mock('../../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({ provider: 'test', model: 'test' }),
}));
vi.mock('../../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({ recordCreated: vi.fn(), recordEvent: vi.fn() }),
}));
vi.mock('../../../../src/host/services/capabilities/capabilityCenterService', () => ({
  getCapabilityCenterService: () => ({ listCapabilities: async () => ({ items: [] }) }),
}));
vi.mock('../../../../src/host/services/roleAssets/nativeSourceProbe', () => ({
  probeUncheckedNativeConnectors: vi.fn(),
}));
vi.mock('../../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getAllToolDefinitions: () => [{ name: 'Read', permissionLevel: 'read' }],
}));
vi.mock('../../../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));

import { getFirstWakeSnapshot, retryFirstWake } from '../../../../src/host/services/roleAssets/roleFirstWake';
import { ROLE_ASSETS } from '../../../../src/shared/constants';

function statePath(roleId: string): string {
  return path.join(harness.configDir, ROLE_ASSETS.ROLES_DIR, roleId, ROLE_ASSETS.FIRST_WAKE_FILENAME);
}

async function writeState(roleId: string, state: Record<string, unknown>): Promise<void> {
  const filePath = statePath(roleId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

beforeEach(async () => {
  harness.configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'first-wake-started-at-'));
  harness.seq = 0;
});

afterEach(async () => {
  await fs.rm(harness.configDir, { recursive: true, force: true });
});

describe('getFirstWakeSnapshot startedAt', () => {
  it.each(['pending', 'running', 'completed'] as const)('%s 的 startedAt 等于状态文件 enqueuedAt', async (state) => {
    const enqueuedAt = 1_700_000_000_000 + (state === 'pending' ? 1 : state === 'running' ? 2 : 3);
    await writeState('snap-clock', {
      state,
      enqueuedAt,
      sourcesMode: 'none',
      suggestions: [],
      ...(state === 'completed' ? { intro: '看完了。' } : {}),
    });
    expect(await getFirstWakeSnapshot('snap-clock')).toEqual({
      state,
      sourcesMode: 'none',
      suggestions: [],
      ...(state === 'completed' ? { intro: '看完了。' } : {}),
      startedAt: enqueuedAt,
    });
  });

  it('enqueuedAt 缺失、null 或非数字时不带 startedAt', async () => {
    await writeState('missing-clock', { state: 'running', sourcesMode: 'none', suggestions: [] });
    expect(await getFirstWakeSnapshot('missing-clock')).toEqual({
      state: 'running',
      sourcesMode: 'none',
      suggestions: [],
    });
    expect(await getFirstWakeSnapshot('missing-clock')).not.toHaveProperty('startedAt');

    await writeState('null-clock', { state: 'running', enqueuedAt: null, sourcesMode: 'none', suggestions: [] });
    expect(await getFirstWakeSnapshot('null-clock')).not.toHaveProperty('startedAt');

    await writeState('text-clock', { state: 'pending', enqueuedAt: 'soon', sourcesMode: 'none', suggestions: [] });
    expect(await getFirstWakeSnapshot('text-clock')).not.toHaveProperty('startedAt');
  });
});

describe('retryFirstWake startedAt', () => {
  it('重看之后快照 startedAt 是新的入队时间', async () => {
    await writeState('retry-clock', {
      state: 'failed',
      enqueuedAt: 1_000,
      sourcesMode: 'none',
      suggestions: [],
      failureReason: 'empty_first_wake_output',
    });
    expect((await getFirstWakeSnapshot('retry-clock'))?.startedAt).toBe(1_000);

    const before = Date.now();
    expect(await retryFirstWake('retry-clock', {
      runner: async () => ({ finalOutput: '看完了，日历这周有三次会。' }),
    })).toEqual({ retried: true });

    await vi.waitFor(async () => {
      const snap = await getFirstWakeSnapshot('retry-clock');
      expect(snap?.state === 'completed' || snap?.state === 'failed').toBe(true);
    });
    const snapshot = await getFirstWakeSnapshot('retry-clock');
    const disk = JSON.parse(await fs.readFile(statePath('retry-clock'), 'utf-8')) as { enqueuedAt: number };
    expect(snapshot?.startedAt).toBe(disk.enqueuedAt);
    expect(snapshot?.startedAt).toBeGreaterThanOrEqual(before);
    expect(snapshot?.startedAt).not.toBe(1_000);
  });
});
