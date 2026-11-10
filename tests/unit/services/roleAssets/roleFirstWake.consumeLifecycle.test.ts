import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { IPCRequest, IPCResponse } from '../../../../src/shared/ipc';
import type { RoleFirstWakeSnapshot } from '../../../../src/shared/contract/roleAssets';

const harness = vi.hoisted(() => ({
  configDir: '',
  listCapabilities: vi.fn(),
  resolveAgent: vi.fn(),
  createSession: vi.fn(),
  calendarRead: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => harness.configDir,
  getAgentsMdDir: () => ({ user: path.join(harness.configDir, 'agents') }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => {
  const logger = { info: harness.info, warn: harness.warn, error: vi.fn(), debug: vi.fn() };
  return { createLogger: () => logger, logger };
});
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getCurrentSessionId: () => null,
    getSession: async () => ({ messages: [] }),
    createSession: harness.createSession,
  }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));
vi.mock('../../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({ provider: 'test', model: 'test' }),
}));
vi.mock('../../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({ recordCreated: vi.fn(), recordEvent: harness.recordEvent }),
}));
vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: (roleId: string) => harness.resolveAgent(roleId),
  listAllAgents: () => [],
}));
vi.mock('../../../../src/host/services/capabilities/capabilityCenterService', () => ({
  getCapabilityCenterService: () => ({ listCapabilities: harness.listCapabilities }),
}));
vi.mock('../../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({
    list: () => [{ id: 'calendar', getCachedStatus: () => ({ readiness: 'ready' }) }],
  }),
}));
vi.mock('../../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getAllToolDefinitions: () => [{ name: 'calendar', permissionLevel: 'read' }],
}));
// Keep unrelated IPC routes from booting the database/cron services. The registered
// roles route, first-wake service, parser, state writes and snapshots remain real.
vi.mock('../../../../src/host/services/core/databaseService', () => ({ getDatabase: vi.fn() }));
vi.mock('../../../../src/host/cron/cronService', () => ({ getCronService: vi.fn() }));

import { registerRolesHandlers } from '../../../../src/host/ipc/roles.ipc';
import { enqueueFirstWake, getFirstWakeSnapshot, skipFirstWake } from '../../../../src/host/services/roleAssets/roleFirstWake';

const ROLE_ID = '小历';
const EVENTS = [
  { title: '项目周会', start: '2026-11-10T09:00:00', preparation: '整理项目周会的议程和待确认事项' },
  { title: '客户方案评审', start: '2026-11-11T14:00:00', preparation: '准备客户方案评审的材料清单' },
  { title: '季度计划讨论', start: '2026-11-12T10:00:00', preparation: '梳理季度计划讨论的重点和问题' },
];
const AGENT_MD = [
  '---',
  'name: 小历',
  'description: 根据日历安排整理会议准备与日程建议',
  'display-name: 小历',
  'profession: 日程规划专家',
  'tools: [calendar]',
  '---',
  '你是日程规划专家。只读日历，结合真实日程提出可委托的准备建议。',
].join('\n');
type Handler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let handler: Handler;

function statePath(roleId: string): string {
  return path.join(harness.configDir, 'roles', roleId, 'first-wake.json');
}

async function readState(roleId: string): Promise<RoleFirstWakeSnapshot> {
  return JSON.parse(await fs.readFile(statePath(roleId), 'utf8')) as RoleFirstWakeSnapshot;
}

async function capture(label: string, value: string): Promise<void> {
  process.stdout.write(`${label}\n${value}\n`);
  // Opt-in capture copies actual production output, never manufactures a state file.
  const outputDir = process.env.NEO_FIRST_WAKE_EVIDENCE_DIR;
  if (outputDir) {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, `${label}.json`), value);
  }
}

async function consume(roleId: string, title: string): Promise<void> {
  const response = await handler(null, { action: 'firstWakeConsumeSuggestion', payload: { roleId, title } });
  expect(response).toEqual({ success: true, data: { success: true } });
}

async function runCalendarExpert(roleId: string): Promise<RoleFirstWakeSnapshot> {
  await fs.mkdir(path.join(harness.configDir, 'agents'), { recursive: true });
  await fs.writeFile(path.join(harness.configDir, 'agents', `${roleId}.md`), AGENT_MD);
  harness.resolveAgent.mockReturnValue({ id: roleId, tools: ['calendar'] });
  const runner = vi.fn(async (input: { prompt: string; allowedToolNames: string[] }) => {
    expect(input.prompt).toContain('日历');
    expect(input.prompt).toContain('first_wake_suggestions');
    expect(input.allowedToolNames).toEqual(['calendar']);
    const events = await harness.calendarRead({ action: 'list_events', limit: 3 }) as typeof EVENTS;
    expect(events).toHaveLength(3);
    const suggestions = events.map((event) => ({ title: `准备${event.title}`, prompt: event.preparation }));
    return {
      finalOutput: [
        '看过你的三场日程，可以帮你提前准备会议材料。也可以一起安排本周的重点。',
        '```first_wake_suggestions', JSON.stringify(suggestions), '```',
      ].join('\n'),
    };
  });
  expect(await enqueueFirstWake(roleId, { runner })).toEqual({ enqueued: true });
  await vi.waitFor(async () => {
    expect(await readState(roleId)).toMatchObject({ state: 'completed', sourcesMode: 'connected' });
    expect(harness.info).toHaveBeenCalledWith('First wake completed', expect.objectContaining({ roleId, sourcesMode: 'connected', suggestions: 3 }));
  });
  expect(runner).toHaveBeenCalledOnce();
  expect(harness.calendarRead).toHaveBeenCalledWith({ action: 'list_events', limit: 3 });
  expect(harness.createSession).toHaveBeenCalledWith(expect.objectContaining({ title: '小历 · 初次见面' }));
  expect(harness.warn).not.toHaveBeenCalled();
  return readState(roleId);
}

beforeEach(async () => {
  vi.clearAllMocks();
  harness.configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-consume-lifecycle-'));
  harness.listCapabilities.mockResolvedValue({ items: [
    { kind: 'connector', name: '日历', source: { kind: 'builtin' }, tags: ['connector', 'native', 'calendar'], state: { runtime: 'connected' } },
  ] });
  harness.calendarRead.mockResolvedValue(EVENTS);
  harness.createSession.mockResolvedValue({ id: 'calendar-first-meeting', messages: [] });
  harness.info.mockImplementation((message: string, details: unknown) => {
    if (message === 'First wake completed' || message.includes('consume missed')) {
      process.stdout.write(`runFirstWake/consume log: ${message} ${JSON.stringify(details)}\n`);
    }
  });
  registerRolesHandlers({ handle: (_channel: string, registered: Handler) => { handler = registered; } } as Parameters<typeof registerRolesHandlers>[0]);
});

afterEach(async () => {
  await fs.rm(harness.configDir, { recursive: true, force: true });
});

describe('connected calendar first-wake production-entry consume lifecycle', () => {
  it('persists three generated suggestions, consumes one through roles IPC, survives reopen, then seals after the last', async () => {
    const before = await runCalendarExpert(ROLE_ID);
    expect(before.suggestions).toHaveLength(3);
    await capture('before-consume', await fs.readFile(statePath(ROLE_ID), 'utf8'));
    const outputDir = process.env.NEO_FIRST_WAKE_EVIDENCE_DIR;
    if (outputDir) {
      await fs.copyFile(statePath(ROLE_ID), path.join(outputDir, 'first-wake.json'));
      await fs.copyFile(path.join(harness.configDir, 'agents', `${ROLE_ID}.md`), path.join(outputDir, 'calendar-lifecycle.md'));
    }
    const [selected, ...remaining] = before.suggestions;
    const remainingBytes = remaining.map((suggestion) => JSON.stringify(suggestion));
    await consume(ROLE_ID, selected!.title);
    const diskAfter = await readState(ROLE_ID);
    expect(diskAfter.state).toBe('completed');
    expect(diskAfter.suggestions.some((suggestion) => suggestion.title === selected!.title)).toBe(false);
    expect(diskAfter.suggestions.map((suggestion) => JSON.stringify(suggestion))).toEqual(remainingBytes);
    expect(diskAfter).toEqual({ ...before, suggestions: remaining });
    await capture('after-one-consume', await fs.readFile(statePath(ROLE_ID), 'utf8'));
    const reopened = await getFirstWakeSnapshot(ROLE_ID);
    expect(reopened?.state).toBe('completed');
    expect(reopened?.suggestions.map((suggestion) => JSON.stringify(suggestion))).toEqual(remainingBytes);
    await capture('reopened-snapshot', JSON.stringify(reopened, null, 2));
    for (const suggestion of remaining) await consume(ROLE_ID, suggestion.title);
    expect(await readState(ROLE_ID)).toMatchObject({ state: 'skipped', suggestions: [] });
    expect(await getFirstWakeSnapshot(ROLE_ID)).toMatchObject({ state: 'skipped', suggestions: [] });
    await capture('all-consumed-snapshot', JSON.stringify(await getFirstWakeSnapshot(ROLE_ID), null, 2));
    const sealedBytes = await fs.readFile(statePath(ROLE_ID), 'utf8');
    await consume(ROLE_ID, selected!.title);
    expect(harness.info).toHaveBeenCalledWith('First wake suggestion consume missed (already skipped)', { roleId: ROLE_ID, title: selected!.title });
    expect(await enqueueFirstWake(ROLE_ID)).toEqual({ enqueued: false, reason: 'exists' });
    expect(await fs.readFile(statePath(ROLE_ID), 'utf8')).toBe(sealedBytes);
    expect(await getFirstWakeSnapshot(ROLE_ID)).toMatchObject({ state: 'skipped', suggestions: [] });
  });

  it('not now seals a fresh generated role and subsequent consume/enqueue cannot recreate suggestions', async () => {
    const roleId = 'calendar-not-now';
    const before = await runCalendarExpert(roleId);
    expect(before.suggestions).toHaveLength(3);
    expect(await skipFirstWake(roleId)).toEqual({ success: true });
    expect(await readState(roleId)).toMatchObject({ state: 'skipped', suggestions: [] });
    expect(await getFirstWakeSnapshot(roleId)).toMatchObject({ state: 'skipped', suggestions: [] });
    await capture('not-now-snapshot', JSON.stringify(await getFirstWakeSnapshot(roleId), null, 2));
    const sealedBytes = await fs.readFile(statePath(roleId), 'utf8');
    await consume(roleId, before.suggestions[0]!.title);
    expect(harness.info).toHaveBeenCalledWith('First wake suggestion consume missed (already skipped)', { roleId, title: before.suggestions[0]!.title });
    expect(await skipFirstWake(roleId)).toEqual({ success: true });
    expect(await enqueueFirstWake(roleId)).toEqual({ enqueued: false, reason: 'exists' });
    expect(await fs.readFile(statePath(roleId), 'utf8')).toBe(sealedBytes);
    expect(await getFirstWakeSnapshot(roleId)).toMatchObject({ state: 'skipped', suggestions: [] });
  });
});
