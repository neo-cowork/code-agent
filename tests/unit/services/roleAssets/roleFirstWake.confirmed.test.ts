import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const harness = vi.hoisted(() => ({ configDir: '', connected: true, seq: 0 }));
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
    createSession: async () => ({ id: `confirmed-${++harness.seq}` }),
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
  getCapabilityCenterService: () => ({ listCapabilities: async () => ({ items: harness.connected ? [{
    kind: 'mcp_template', name: 'Meeting notes', source: { kind: 'user' },
    tags: ['mcp', 'user'], state: { runtime: 'connected' },
  }] : [] }) }),
}));
vi.mock('../../../../src/host/services/roleAssets/nativeSourceProbe', () => ({
  probeUncheckedNativeConnectors: vi.fn(),
}));
vi.mock('../../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getAllToolDefinitions: () => [{ name: 'Read', permissionLevel: 'read' }],
}));
vi.mock('../../../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));

import { enqueueFirstWake, getFirstWakeSnapshot } from '../../../../src/host/services/roleAssets/roleFirstWake';
import { writeRolePersonalization, readRolePersonalization } from '../../../../src/host/services/roleAssets/rolePersonalization';

beforeEach(async () => {
  harness.configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'first-wake-confirmed-'));
  harness.connected = true;
});
afterEach(async () => { await fs.rm(harness.configDir, { recursive: true, force: true }); });

async function runOutput(output: string, expectation = '') {
  const roleId = `meeting-${++harness.seq}`;
  await fs.mkdir(path.join(harness.configDir, 'roles', roleId), { recursive: true });
  writeRolePersonalization(roleId, { userExpectation: expectation });
  let prompt = '';
  await enqueueFirstWake(roleId, { runner: async (input) => {
    prompt = input.prompt;
    return { finalOutput: output };
  } });
  await vi.waitFor(async () => {
    expect(await getFirstWakeSnapshot(roleId)).toMatchObject({ state: 'completed' });
  });
  return { prompt, snapshot: await getFirstWakeSnapshot(roleId), saved: readRolePersonalization(roleId) };
}
function output(items: Array<{ title: string; prompt: string }>) {
  return `I can help prepare your meeting notes.\n\`\`\`first_wake_suggestions\n${JSON.stringify(items)}\n\`\`\``;
}

describe('first meeting after confirmation (public enqueue/snapshot)', () => {
  it.each([true, false])('confirmed prompt rule and stale expectation removal, connected=%s', async (connected) => {
    harness.connected = connected;
    const expectation = 'Help prepare my weekly meeting notes. send me the pending card.\n先把待确认卡发给我。';
    const result = await runOutput(output([]), expectation);
    expect(result.prompt).toContain('用户已经确认创建了你这位专家');
    expect(result.prompt).toContain('不要建议发送、查看或确认任何待处理的确认卡或草稿');
    expect(result.prompt).toContain('Help prepare my weekly meeting notes');
    expect(result.prompt).not.toContain('send me the pending card');
    expect(result.prompt).not.toContain('先把待确认卡发给我');
    expect(result.saved.userExpectation).toBe(expectation);
    expect(result.snapshot?.sourcesMode).toBe(connected ? 'connected' : 'none');
  });

  it('drops send me the pending card and zh/en stale variants in either field before the cap, keeps normal drafts', async () => {
    const normal = [
      { title: 'Draft meeting notes', prompt: 'Draft notes from my meeting outline' },
      { title: 'Make flashcards', prompt: 'Make flashcards of meeting vocabulary' },
      { title: 'List open decisions', prompt: 'List decisions still pending in my notes' },
    ];
    const stale = [
      { title: 'Start here', prompt: 'send me the pending card' },
      { title: 'Show me the pending card first', prompt: 'Begin preparing notes' },
      { title: 'Review', prompt: 'Show the pending confirmation card' },
      { title: 'Confirm', prompt: 'Confirm the pending draft' },
      { title: '先看确认卡', prompt: '帮我准备会议' },
      { title: '开始', prompt: '先把待确认草稿发给我' },
    ];
    const result = await runOutput(output([...stale, ...normal]));
    expect(result.snapshot?.suggestions).toEqual(normal);
  });
});
