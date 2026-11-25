// ============================================================================
// propose_role / propose_team_recipe 回执不宣称确认卡可见
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const sessionState = vi.hoisted(() => ({
  messages: [] as Array<{ id: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; timestamp: number; isMeta?: boolean }>,
  origin: undefined as undefined | { kind: string },
  unattended: false,
  others: {} as Record<string, { title: string }>,
}));
const firstWake = vi.hoisted(() => ({ enqueue: vi.fn(async (_roleId: string) => ({ enqueued: true })) }));
const teamService = vi.hoisted(() => ({ knownRoleIds: vi.fn(), create: vi.fn() }));

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
    getSession: async (id: string) =>
      sessionState.others[id] ?? (id === 'sess-1' ? { origin: sessionState.origin } : null),
  }),
}));

vi.mock('../../../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({
    isUnattendedSession: () => sessionState.unattended,
    clampForRateLimit: (mode: string) => mode,
    getModeForSession: () => 'acceptEdits',
  }),
  permissionModeAutoApproves: (mode: string, level: string) => mode === 'acceptEdits' && level === 'write',
}));

vi.mock('../../../../src/host/services/roleAssets/roleFirstWake', () => ({
  enqueueFirstWake: (roleId: string) => firstWake.enqueue(roleId),
}));

vi.mock('../../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class ToolExecutor {},
}));

vi.mock('../../../../src/host/services/team/teamRecipeService', () => ({
  getTeamRecipeService: () => teamService,
}));

import { proposeRoleModule } from '../../../../src/host/tools/modules/roleAuthoring/proposeRole';
import { proposeTeamRecipeModule } from '../../../../src/host/tools/modules/teamAuthoring/proposeTeamRecipe';

const allow = vi.fn(async () => ({ allow: true }));

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    workingDir: mockConfigDir.dir,
    abortSignal: { aborted: false } as AbortSignal,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emit: vi.fn(),
    ...overrides,
  };
}

function assertReceiptMakesNoCardClaim(output: string, draftName: string): void {
  expect(output).not.toContain('已弹出');
  expect(output).not.toContain('确认卡已');
  expect(output).not.toContain('当前对话有确认卡');
  expect(output).toContain(draftName);
  expect(output).toContain('需用户确认');
}

describe('propose_role / propose_team_recipe receipts do not claim card shown without ack', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'propose-receipt-'));
    sessionState.messages = [{ id: 'u1', role: 'user', content: '帮我建一个每天整理竞品新闻的专家', timestamp: 1 }];
    sessionState.origin = undefined;
    sessionState.unattended = false;
    sessionState.others = {};
    firstWake.enqueue.mockClear();
    teamService.knownRoleIds.mockResolvedValue(new Set(['牧之', '溯真']));
    teamService.create.mockImplementation(async (recipe: Record<string, unknown>) => ({ ...recipe, id: 'user-confirmed' }));
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('propose_role create receipt omits card-shown claims when ctx.emit never acknowledges', async () => {
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      {
        roleId: '竞品情报员',
        description: '每天整理竞品新闻与动态',
        category: 'research',
        tools: ['WebSearch', 'WebFetch'],
        systemPrompt: '你是竞品情报员，负责整理竞品新闻。',
      },
      ctx as never,
      allow as never,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(ctx.emit).toHaveBeenCalledTimes(1);
    expect(ctx.emit.mock.calls[0][0].type).toBe('role_draft_pending');
    assertReceiptMakesNoCardClaim(result.output, '竞品情报员');
    expect(result.output).toContain('确认前不会创建或入库');
  });

  it('propose_role edit receipt omits card-shown claims when ctx.emit never acknowledges', async () => {
    await fs.mkdir(path.join(mockConfigDir.dir, 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(mockConfigDir.dir, 'agents', '竞品情报员.md'),
      '---\nname: 竞品情报员\ndescription: 旧描述\ntools: WebSearch\n---\n旧提示词\n',
      'utf8',
    );
    const handler = await proposeRoleModule.createHandler();
    const ctx = makeCtx();
    const result = await handler.execute(
      {
        editingRoleId: '竞品情报员',
        roleId: '竞品情报员',
        description: '新描述',
        category: 'research',
        tools: ['WebSearch', 'WebFetch'],
        systemPrompt: '新提示词',
      },
      ctx as never,
      allow as never,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(ctx.emit).toHaveBeenCalledTimes(1);
    expect(ctx.emit.mock.calls[0][0].type).toBe('role_draft_pending');
    assertReceiptMakesNoCardClaim(result.output, '竞品情报员');
    expect(result.output).toContain('确认前不会修改或入库');
  });

  it('propose_role cross-session rejection keeps the no-card-in-this-chat prohibition unchanged', async () => {
    sessionState.others['sess-other'] = { title: '竞品专家草稿' };
    const handler = await proposeRoleModule.createHandler();
    const first = await handler.execute(
      {
        roleId: '竞品情报员',
        description: '每天整理竞品新闻',
        systemPrompt: '你是竞品情报员。',
      },
      makeCtx({ sessionId: 'sess-other' }) as never,
      allow as never,
    );
    expect(first.ok).toBe(true);

    const ctx = makeCtx({ sessionId: 'sess-current' });
    const second = await handler.execute(
      {
        roleId: '竞品情报员',
        description: '每天整理竞品新闻',
        systemPrompt: '你是竞品情报员。',
      },
      ctx as never,
      allow as never,
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected rejection');
    expect(second.code).toBe('DRAFT_REJECTED');
    expect(ctx.emit).not.toHaveBeenCalled();
    expect(second.error).toContain('当前这个对话里没有确认卡');
    expect(second.error).toContain('不要说当前对话有确认卡');
  });

  it('propose_team_recipe receipt omits card-shown claims when ctx.emit never acknowledges', async () => {
    const handler = await proposeTeamRecipeModule.createHandler();
    const ctx = makeCtx({ sessionId: 'team-session' });
    const result = await handler.execute(
      {
        name: '调研小组',
        description: '两位专家协作完成调研',
        category: 'research',
        members: [
          { roleId: '牧之', taskTemplate: '梳理 {topic} 的核心框架' },
          { roleId: '溯真', taskTemplate: '核查 {topic} 的事实与来源' },
        ],
      },
      ctx as never,
      allow as never,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(ctx.emit).toHaveBeenCalledTimes(1);
    expect(ctx.emit.mock.calls[0][0].type).toBe('team_recipe_draft_pending');
    assertReceiptMakesNoCardClaim(result.output, '调研小组');
    expect(result.output).toContain('用户确认前不会入库');
    expect(result.output).toContain('需要修改时请带完整新定义重新起草');
  });
});
