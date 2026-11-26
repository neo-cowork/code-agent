// ============================================================================
// propose_role dailyBriefTime — 模型填结构化字段，host 只校验并落盘。
// 走生产入口：propose_role handler（直接创建路径）与 confirmRoleDraft（确认卡路径），
// 真实 configService（临时数据目录），cron 服务用记录型替身。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const sessionState = vi.hoisted(() => ({
  messages: [] as Array<{ id: string; role: 'user'; content: string; timestamp: number }>,
}));
const cronJobs = vi.hoisted(() => ({ created: [] as Array<Record<string, unknown>>, existing: [] as Array<Record<string, unknown>> }));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async () => sessionState.messages,
    getSession: async () => ({ origin: undefined }),
  }),
}));
vi.mock('../../../../src/host/permissions/modes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/host/permissions/modes')>()),
  getPermissionModeManager: () => ({ isUnattendedSession: () => false }),
}));
vi.mock('../../../../src/host/services/roleAssets/roleFirstWake', () => ({
  enqueueFirstWake: async () => ({ enqueued: true }),
}));
vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: () => undefined,
  reloadAgentRegistry: async () => undefined,
}));
vi.mock('../../../../src/host/cron/cronService', () => ({
  getCronService: () => ({
    listJobs: () => cronJobs.existing,
    createJob: async (job: Record<string, unknown>) => { cronJobs.created.push(job); return job; },
    updateJob: async () => undefined,
    deleteJob: async () => undefined,
  }),
}));
vi.stubEnv('CODE_AGENT_WEB_MODE', 'true');

type Handler = Awaited<ReturnType<typeof import('../../../../src/host/tools/modules/roleAuthoring/proposeRole')['proposeRoleModule']['createHandler']>>;
let handler: Handler;
let queue: typeof import('../../../../src/host/services/roleAssets/roleDraftQueue');
let proactivity: typeof import('../../../../src/host/services/roleAssets/roleProactivity');
let configMod: typeof import('../../../../src/host/services/core/configService');

const allow = vi.fn(async () => ({ allow: true }));

function makeCtx() {
  return {
    sessionId: 'sess-1',
    workingDir: mockConfigDir.dir,
    abortSignal: { aborted: false } as AbortSignal,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emit: vi.fn(),
  };
}
function setLatestUser(content: string): void {
  sessionState.messages = [{ id: 'u1', role: 'user', content, timestamp: 1 }];
}
const DIRECT = '创建一个专家，名字叫「晨间巡检」。直接创建，不用再问我问题。';
const CONFIRM = '帮我想想要不要建个晨间巡检专家';

async function run(args: Record<string, unknown>, userText: string) {
  setLatestUser(userText);
  const ctx = makeCtx();
  const result = await handler.execute(
    { roleId: '晨间巡检', description: '每天巡检', systemPrompt: '你是晨间巡检专家。', ...args },
    ctx as never,
    allow as never,
  );
  return { result, ctx };
}
async function level(roleId = '晨间巡检') {
  return proactivity.resolveRoleProactivityConfig(roleId);
}
async function confirmDraft(ctx: ReturnType<typeof makeCtx>) {
  const event = ctx.emit.mock.calls.map((c) => c[0]).find((e) => e.type === 'role_draft_pending');
  return queue.confirmRoleDraft(event.data.drafts[0].id);
}

beforeEach(async () => {
  mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'propose-role-daily-'));
  cronJobs.created = []; cronJobs.existing = [];
  vi.resetModules();
  handler = await (await import('../../../../src/host/tools/modules/roleAuthoring/proposeRole')).proposeRoleModule.createHandler();
  queue = await import('../../../../src/host/services/roleAssets/roleDraftQueue');
  proactivity = await import('../../../../src/host/services/roleAssets/roleProactivity');
  configMod = await import('../../../../src/host/services/core/configService');
  const service = configMod.getConfigService() as unknown as { configPath: string; initialize: () => Promise<void> };
  service.configPath = path.join(mockConfigDir.dir, 'config.json');
  await service.initialize();
});
afterEach(async () => {
  await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
});

describe('propose_role dailyBriefTime', () => {
  it('② 直接创建路径：09:00 → daily + 0 0 9 * * *，并注册 cron', async () => {
    const { result } = await run({ dailyBriefTime: '09:00' }, DIRECT);
    expect(result.ok).toBe(true);
    expect(await level()).toMatchObject({ level: 'daily', cadence: '0 0 9 * * *' });
    expect(cronJobs.created).toHaveLength(1);
    expect(cronJobs.created[0]).toMatchObject({ schedule: { type: 'cron', expression: '0 0 9 * * *' }, action: { type: 'role-wake', roleId: '晨间巡检' } });
  });

  it('② 直接创建路径：08:30 → 0 30 8 * * *', async () => {
    await run({ dailyBriefTime: '08:30' }, DIRECT);
    expect(await level()).toMatchObject({ level: 'daily', cadence: '0 30 8 * * *' });
  });

  it('② 确认卡路径：09:00 / 08:30 经 confirmRoleDraft 落成 daily + cadence，输出行复述时间', async () => {
    const first = await run({ dailyBriefTime: '09:00' }, CONFIRM);
    expect(first.result.ok && first.result.output).toContain('09:00');
    expect((await confirmDraft(first.ctx)).success).toBe(true);
    expect(await level()).toMatchObject({ level: 'daily', cadence: '0 0 9 * * *' });

    const second = await run({ roleId: '午前巡检', dailyBriefTime: '08:30' }, CONFIRM);
    expect((await confirmDraft(second.ctx)).success).toBe(true);
    expect(await level('午前巡检')).toMatchObject({ level: 'daily', cadence: '0 30 8 * * *' });
  });

  it('③ 不给时间 → silent，无 cron；系统提示词写「默认每天 9 点」但字段缺省也 silent', async () => {
    await run({}, DIRECT);
    expect((await level()).level).toBe('silent');
    await run({ roleId: '另一位', systemPrompt: '你是巡检专家。默认每天 9 点醒来汇报。' }, DIRECT);
    expect((await level('另一位')).level).toBe('silent');
    expect(cronJobs.created).toHaveLength(0);
  });

  it.each(['9点', '25:00', '9:00', '08:60'])('④ 非法值 %s → 拒绝并点名 HH:mm，未写任何东西', async (bad) => {
    const { result } = await run({ dailyBriefTime: bad }, DIRECT);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('HH:mm');
    expect(await fs.access(path.join(mockConfigDir.dir, 'agents', '晨间巡检.md')).then(() => true, () => false)).toBe(false);
    expect(await fs.readdir(path.join(mockConfigDir.dir, 'role-drafts')).catch(() => [])).toEqual([]);
    expect(cronJobs.created).toHaveLength(0);
  });

  it('④ 确认卡路径的非法值同样拒绝且不入队', async () => {
    const { result } = await run({ dailyBriefTime: '9点' }, CONFIRM);
    expect(result.ok).toBe(false);
    expect(await fs.readdir(path.join(mockConfigDir.dir, 'role-drafts')).catch(() => [])).toEqual([]);
  });

  it('④ editingRoleId + dailyBriefTime → 已有 cadence 不动', async () => {
    await run({ dailyBriefTime: '07:15' }, DIRECT);
    expect(await level()).toMatchObject({ level: 'daily', cadence: '0 15 7 * * *' });
    const edited = await run({ editingRoleId: '晨间巡检', dailyBriefTime: '09:00', description: '改过' }, CONFIRM);
    expect(edited.result.ok).toBe(true);
    expect((await confirmDraft(edited.ctx)).success).toBe(true);
    expect(await level()).toMatchObject({ level: 'daily', cadence: '0 15 7 * * *' });
  });
});
