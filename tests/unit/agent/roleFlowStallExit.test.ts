// ============================================================================
// roleFlowStallExit 测试 — 建/改角色严格流程的停摆出口（FB-327）
// 复现形状：create-role 激活的轮回以纯文本收尾，既没有 propose_role 草稿、也没有
// 留给用户的问句 → 会话静默空闲。出口必须把这一轮变成用户可见的「继续/放弃」说明。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../../../src/shared/contract';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const listRoleDraftsMock = vi.fn();
vi.mock('../../../src/host/services/roleAssets/roleDraftQueue', () => ({
  listRoleDrafts: (...args: unknown[]) => listRoleDraftsMock(...args),
}));

const { settleRoleFlowStallOnTextBreak } = await import('../../../src/host/agent/runtime/roleFlowStallExit');

const SESSION_ID = 'session-1';

const createRoleBoundary = { skillName: 'create-role', allowedTools: ['propose_role', 'exit_role_flow', 'list_experts', 'ask_user_question', 'read_file', 'glob', 'grep'], strict: true as const };
const editRoleBoundary = { skillName: 'edit-role', allowedTools: ['propose_role', 'exit_role_flow', 'list_experts', 'read_file', 'ask_user_question', 'glob', 'grep'], strict: true as const };

const SEED: Message = { id: 'u-seed', role: 'user', content: '/create-role 一个晨报摘要员', timestamp: 1 };

function proposeHistory(success: boolean): Message[] {
  return [
    SEED,
    { id: 'a1', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: 'tc-1', name: 'propose_role', arguments: {} }] },
    { id: 't1', role: 'tool', content: '', timestamp: 3, toolResults: [{ toolCallId: 'tc-1', success, ...(success ? { output: 'ok' } : { error: 'bad' }) }] },
  ] as Message[];
}

function mkCtx(messages: Message[] = [SEED]) {
  return { sessionId: SESSION_ID, onEvent: vi.fn(), messages };
}

function mkAssembly() {
  const persisted: Message[] = [];
  return {
    persisted,
    addAndPersistMessage: vi.fn(async (message: Message) => { persisted.push(message); }),
    generateId: () => `msg-${persisted.length + 1}`,
  };
}

beforeEach(() => {
  listRoleDraftsMock.mockReset();
  listRoleDraftsMock.mockResolvedValue([]);
});

// 判定谓词不对外导出（knip 生产口径），经 settle 的返回值（是否落了停摆说明）观察。
async function shouldSurfaceRoleFlowStall(
  boundary: Parameters<typeof settleRoleFlowStallOnTextBreak>[0]['boundary'],
  finalText: string,
  hasPendingDraft: boolean,
): Promise<boolean> {
  listRoleDraftsMock.mockResolvedValue(hasPendingDraft ? [{ sessionId: SESSION_ID }] : []);
  return settleRoleFlowStallOnTextBreak({ ctx: mkCtx(), assembly: mkAssembly(), boundary, finalText });
}

describe('停摆判定（经 settle 观察）', () => {
  it('create-role strict 边界 + 无草稿 + 收尾无问句 → 判停摆', async () => {
    expect(await shouldSurfaceRoleFlowStall(createRoleBoundary, '草稿好了，回复「确认」我就创建。', false)).toBe(true);
  });

  it('本会话已有 pending 草稿 → 不判停摆（确认卡在场，空闲是等确认）', async () => {
    expect(await shouldSurfaceRoleFlowStall(createRoleBoundary, '草稿好了。', true)).toBe(false);
  });

  it('收尾文本带问句（中/英）→ 不判停摆（合法访谈收尾）', async () => {
    expect(await shouldSurfaceRoleFlowStall(createRoleBoundary, '想招个干什么的专家？', false)).toBe(false);
    expect(await shouldSurfaceRoleFlowStall(createRoleBoundary, 'what kind of expert? tell me', false)).toBe(false);
  });

  it('edit-role 同样受停摆出口保护', async () => {
    expect(await shouldSurfaceRoleFlowStall(editRoleBoundary, '已经按你的意思改好了。', false)).toBe(true);
  });

  it('非建/改角色的 strict 边界（dream/distill）不触发', async () => {
    expect(await shouldSurfaceRoleFlowStall({ skillName: 'dream', allowedTools: ['Read'], strict: true }, '没有输出', false)).toBe(false);
  });

  it('非 strict 软边界 / 无边界不触发', async () => {
    expect(await shouldSurfaceRoleFlowStall({ skillName: 'create-role', allowedTools: ['propose_role'] }, '念完收工', false)).toBe(false);
    expect(await shouldSurfaceRoleFlowStall(undefined, '念完收工', false)).toBe(false);
  });
});

describe('settleRoleFlowStallOnTextBreak 落卡', () => {
  it('停摆成立：持久化并广播 role:system 消息，metadata 带登记键 roleFlowStalled', async () => {
    const ctx = mkCtx();
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx, assembly, boundary: createRoleBoundary,
      finalText: '我把「竞品动态研究员」的草稿拟好了，内容没问题的话回复「确认」。',
    });
    expect(fired).toBe(true);
    expect(assembly.addAndPersistMessage).toHaveBeenCalledTimes(1);
    const message = assembly.persisted[0];
    expect(message.role).toBe('system');
    expect(message.metadata?.roleFlowStalled).toEqual({ skillName: 'create-role' });
    // 用户视角的三要素：说清没有草稿、说清没创建任何东西、给继续/放弃路径
    expect(message.content).toContain('没有生成草稿');
    expect(message.content).toContain('还没有任何角色被创建或修改');
    expect(message.content).toContain('/create-role');
    expect(ctx.onEvent).toHaveBeenCalledWith({ type: 'message', data: message });
  });

  it('edit-role 停摆：文案指向 /edit-role', async () => {
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx: mkCtx(), assembly, boundary: editRoleBoundary, finalText: '改好了，等你确认。',
    });
    expect(fired).toBe(true);
    expect(assembly.persisted[0].content).toContain('/edit-role');
    expect(assembly.persisted[0].metadata?.roleFlowStalled).toEqual({ skillName: 'edit-role' });
  });

  it('草稿属于其他会话 → 视同无草稿，照常判停摆', async () => {
    listRoleDraftsMock.mockResolvedValue([{ sessionId: 'other-session' }]);
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx: mkCtx(), assembly, boundary: createRoleBoundary, finalText: '好了。',
    });
    expect(fired).toBe(true);
  });

  it('本会话已有 pending 草稿 → 不落卡不发事件', async () => {
    listRoleDraftsMock.mockResolvedValue([{ sessionId: SESSION_ID }]);
    const ctx = mkCtx();
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx, assembly, boundary: createRoleBoundary, finalText: '草稿好了。',
    });
    expect(fired).toBe(false);
    expect(assembly.addAndPersistMessage).not.toHaveBeenCalled();
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });

  it('listRoleDrafts 读盘失败 → 按无草稿处理，出口不因 IO 错误哑掉（fail-visible）', async () => {
    listRoleDraftsMock.mockRejectedValue(new Error('disk error'));
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx: mkCtx(), assembly, boundary: createRoleBoundary, finalText: '好了。',
    });
    expect(fired).toBe(true);
    expect(assembly.persisted.length).toBe(1);
  });

  it('落库失败 → 不抛红（出口不把正常收尾变失败），返回 false', async () => {
    const ctx = mkCtx();
    const assembly = mkAssembly();
    assembly.addAndPersistMessage.mockRejectedValue(new Error('db down'));
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx, assembly, boundary: createRoleBoundary, finalText: '好了。',
    });
    expect(fired).toBe(false);
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });
});


// N-ROLE-STALL-FALSE-ALARM-AFTER-CONFIRM
describe('propose_role 已成功后不再误报停摆', () => {
  it('种子后有成功 propose_role + 草稿已被确认移走（列表为空）→ 不落卡不发事件', async () => {
    const ctx = mkCtx(proposeHistory(true));
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx, assembly, boundary: createRoleBoundary, finalText: '已创建，谢谢。',
    });
    expect(fired).toBe(false);
    expect(assembly.addAndPersistMessage).not.toHaveBeenCalled();
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });

  it('同上但 listRoleDrafts 读盘失败 → 仍不误报', async () => {
    listRoleDraftsMock.mockRejectedValue(new Error('disk error'));
    const ctx = mkCtx(proposeHistory(true));
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx, assembly, boundary: createRoleBoundary, finalText: '已创建。',
    });
    expect(fired).toBe(false);
    expect(assembly.addAndPersistMessage).not.toHaveBeenCalled();
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });

  it('propose_role 结果 success:false → 仍判停摆', async () => {
    const assembly = mkAssembly();
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx: mkCtx(proposeHistory(false)), assembly, boundary: createRoleBoundary, finalText: '失败了。',
    });
    expect(fired).toBe(true);
    expect(assembly.persisted).toHaveLength(1);
  });

  it('成功的 propose_role 在更早的 /create-role 种子之前 → 不算本次流程的产出，仍判停摆', async () => {
    const messages = [...proposeHistory(true), { id: 'u-seed2', role: 'user', content: '/create-role 另一个', timestamp: 9 } as Message];
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx: mkCtx(messages), assembly: mkAssembly(), boundary: createRoleBoundary, finalText: '好了。',
    });
    expect(fired).toBe(true);
  });

  it('同一轮连续两次 settle → 只落一条；下一轮（新 user 消息）可再落', async () => {
    const ctx = mkCtx();
    const assembly = mkAssembly();
    const input = { ctx, assembly, boundary: createRoleBoundary, finalText: '好了。' };
    expect(await settleRoleFlowStallOnTextBreak(input)).toBe(true);
    expect(await settleRoleFlowStallOnTextBreak(input)).toBe(false);
    expect(assembly.persisted).toHaveLength(1);
    expect(ctx.onEvent).toHaveBeenCalledTimes(1);
    ctx.messages.push({ id: 'u-next', role: 'user', content: '继续', timestamp: 20 } as Message);
    expect(await settleRoleFlowStallOnTextBreak(input)).toBe(true);
    expect(assembly.persisted).toHaveLength(2);
  });

  it('回放 propose_role 成功 → 确认（草稿移除）→ 收尾文本：持久化序列里没有停摆消息', async () => {
    const ctx = mkCtx(proposeHistory(true));
    const assembly = mkAssembly();
    listRoleDraftsMock.mockResolvedValueOnce([{ sessionId: SESSION_ID }]); // 确认前：卡在场
    await settleRoleFlowStallOnTextBreak({ ctx, assembly, boundary: createRoleBoundary, finalText: '草稿好了。' });
    listRoleDraftsMock.mockResolvedValue([]); // 用户点了确认，草稿目录被删
    await settleRoleFlowStallOnTextBreak({ ctx, assembly, boundary: createRoleBoundary, finalText: '角色已创建。' });
    expect(assembly.persisted.filter((m) => m.metadata?.roleFlowStalled)).toEqual([]);
  });
});

describe('用户结束角色流程', () => {
  it('问答卡选择先别建时不落停摆消息', async () => {
    const ctx = mkCtx([
      SEED,
      { id: 'a-question', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: 'q1', name: 'AskUserQuestion', arguments: { questions: [{"header": "主要职责", "question": "这个角色主要帮你干什么活？", "options": [{"label": "整理信息做研究", "description": "上网查资料、汇总对比、写出结论"}, {"label": "写文档做汇报", "description": "写方案、纪要、PPT、报告类产出"}, {"label": "处理数据和表格", "description": "读写 Excel、统计分析、出图表"}, {"label": "自动化跑腿", "description": "定时任务、批量处理文件等重复活"}], "multiSelect": false}, {"header": "需要能力", "question": "它需要哪些能力？（可多选，我会按最少够用来配）", "options": [{"label": "联网搜索", "description": "上网查资料、抓网页内容"}, {"label": "读写本地文件", "description": "查看和生成文档、表格等文件"}, {"label": "运行命令", "description": "执行脚本、跑测试等（权限较高，会说明）"}, {"label": "记忆和日程", "description": "记住你的偏好、读写提醒和日历"}], "multiSelect": true}]} }] },
      { id: 't-answer', role: 'tool', content: '', timestamp: 3, toolResults: [{ toolCallId: 'q1', success: true, output: 'User responses:\n[主要职责]: 先别建，现有够用\n[需要能力]: 先别建，现有够用' }] },
    ]);
    const assembly = mkAssembly();
    expect(await settleRoleFlowStallOnTextBreak({ ctx, assembly, boundary: createRoleBoundary, finalText: '好的，先使用现有角色。' })).toBe(false);
    expect(assembly.persisted).toEqual([]);
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });

  it('用户之后要求继续时不沿用之前的拒绝', async () => {
    const ctx = mkCtx([SEED, { id: 'u-no', role: 'user', content: '先别建', timestamp: 2 }, { id: 'u-yes', role: 'user', content: '继续创建', timestamp: 3 }]);
    expect(await settleRoleFlowStallOnTextBreak({ ctx, assembly: mkAssembly(), boundary: createRoleBoundary, finalText: '正在准备。' })).toBe(true);
  });

  it('无头未回答输出中的不要创建不视为用户拒绝', async () => {
    const ctx = mkCtx([SEED, { id: 'a', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: 'q', name: 'AskUserQuestion', arguments: {} }] }, { id: 't', role: 'tool', content: '', timestamp: 3, toolResults: [{ toolCallId: 'q', success: true, output: '[用户未响应 - CLI 模式无法交互]\n不要创建文件' }] }]);
    expect(await settleRoleFlowStallOnTextBreak({ ctx, assembly: mkAssembly(), boundary: createRoleBoundary, finalText: '正在准备。' })).toBe(true);
  });

  it('确认卡已生成的真实消息形状不落停摆消息', async () => {
    const messages = proposeHistory(true);
    messages[2].toolResults![0].output = '已为「晨报摘要员」生成草稿，确认卡已弹出，等待用户点击确认。';
    const ctx = mkCtx(messages);
    const assembly = mkAssembly();
    expect(await settleRoleFlowStallOnTextBreak({ ctx, assembly, boundary: createRoleBoundary, finalText: '请在确认卡上点击确认完成创建' })).toBe(false);
    expect(assembly.persisted.filter((message) => message.metadata?.roleFlowStalled)).toEqual([]);
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });
});


describe('r1: 角色能力需求中的否定不等于放弃建角色', () => {
  const requirementAnswers = [
    '不需要生成图片',
    '它不需要生成图片，只要文字摘要',
    '不要做数据分析',
    '不用改格式',
    "don't make it too formal",
  ];

  for (const answerSource of ['user', 'question'] as const) {
    it.each(requirementAnswers)(`${answerSource}: %s 后纯进度收尾仍落一条停摆消息`, async (answer) => {
      const answerMessages: Message[] = answerSource === 'user'
        ? [{ id: 'u-answer', role: 'user', content: answer, timestamp: 3 }]
        : [
          { id: 'a-question', role: 'assistant', content: '', timestamp: 2, toolCalls: [{
            id: 'q-requirement', name: 'AskUserQuestion', arguments: { questions: [{
              header: '需要能力', question: '它需要哪些能力？（可多选，我会按最少够用来配）',
              options: [
                { label: '联网搜索', description: '上网查资料、抓网页内容' },
                { label: '读写本地文件', description: '查看和生成文档、表格等文件' },
              ], multiSelect: true,
            }] },
          }] },
          { id: 't-answer', role: 'tool', content: '', timestamp: 3, toolResults: [{
            toolCallId: 'q-requirement', success: true, output: `User responses:\n[需要能力]: ${answer}`,
          }] },
        ];
      const ctx = mkCtx([SEED, ...answerMessages]);
      const assembly = mkAssembly();
      const input = { ctx, assembly, boundary: createRoleBoundary, finalText: '第一步：分析需求。' };
      expect(await settleRoleFlowStallOnTextBreak(input)).toBe(true);
      expect(await settleRoleFlowStallOnTextBreak(input)).toBe(false);
      expect(assembly.persisted).toHaveLength(1);
      expect(assembly.persisted[0].metadata?.roleFlowStalled).toEqual({ skillName: 'create-role' });
      expect(ctx.onEvent).toHaveBeenCalledTimes(1);
    });
  }

  it.each(['先别建，现有够用', '不用创建了', '不要新建角色', '暂时不修改角色', "don't create a role"])(
    '明确针对角色的拒绝仍抑制提示: %s', async (answer) => {
      const ctx = mkCtx([SEED, { id: 'u-decline', role: 'user', content: answer, timestamp: 2 }]);
      const assembly = mkAssembly();
      expect(await settleRoleFlowStallOnTextBreak({ ctx, assembly, boundary: createRoleBoundary, finalText: '好的，暂不创建。' })).toBe(false);
      expect(assembly.persisted).toEqual([]);
      expect(ctx.onEvent).not.toHaveBeenCalled();
    },
  );
});

describe('自然语言种子', () => {
  it('自然语言建角色种子之后已成功 propose_role → 查不到 pending 草稿也不判停摆', async () => {
    const history = proposeHistory(true);
    history[0] = { ...SEED, content: '帮我创建一个日程管家专家，负责看日历和提醒' };
    listRoleDraftsMock.mockResolvedValue([]);
    const fired = await settleRoleFlowStallOnTextBreak({
      ctx: mkCtx(history), assembly: mkAssembly(), boundary: createRoleBoundary, finalText: '好了。',
    });
    expect(fired).toBe(false);
  });
});
