// ============================================================================
// conversationRuntimeStickySkill 测试 — 严格技能粘滞恢复的退出条件
// 真实故障（2026-07-21）：建角色草稿晾着时，无关请求也被锁在 5 个工具里。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../../../src/shared/contract';

const routeLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/services/infra/logger')>(),
  createLogger: () => routeLog,
}));
vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: { agent: vi.fn() },
}));

const resolveSkillInvocationMock = vi.fn();
vi.mock('../../../src/host/services/skills/skillInvocationResolver', () => ({
  resolveSkillInvocation: (...args: unknown[]) => resolveSkillInvocationMock(...args),
}));

const listRoleDraftsMock = vi.fn();
vi.mock('../../../src/host/services/roleAssets/roleDraftQueue', () => ({
  listRoleDrafts: (...args: unknown[]) => listRoleDraftsMock(...args),
}));

import { resolveStickyStrictSkillInvocation, resolveNaturalLanguageCreateRoleInvocation } from '../../../src/host/agent/runtime/conversationRuntimeStickySkill';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

const SESSION_ID = 'session-1';

function userMsg(content: string, extra?: Partial<Message>): Message {
  return { id: `m${Math.random()}`, role: 'user', content, timestamp: 0, ...extra };
}

function assistantMsg(content: string, toolNames: string[] = []): Message {
  return {
    id: `m${Math.random()}`,
    role: 'assistant',
    content,
    timestamp: 0,
    ...(toolNames.length > 0
      ? { toolCalls: toolNames.map((name, i) => ({ id: `c${i}`, name, arguments: {} })) }
      : {}),
  };
}

function mkCtx(messages: Message[], sessionId = SESSION_ID): RuntimeContext {
  return { messages, sessionId, workingDirectory: '/tmp/wd' } as unknown as RuntimeContext;
}

const createRoleInvocation = {
  skill: { name: 'create-role', strictToolset: true },
  matchKind: 'slash',
  matchedText: '/create-role',
};

beforeEach(() => {
  routeLog.info.mockClear();
  routeLog.warn.mockClear();
  resolveSkillInvocationMock.mockReset();
  resolveSkillInvocationMock.mockImplementation(async (text: string) =>
    text.trim().startsWith('/create-role') ? createRoleInvocation : null,
  );
  listRoleDraftsMock.mockReset();
  listRoleDraftsMock.mockResolvedValue([]);
});

describe('resolveStickyStrictSkillInvocation 退出条件', () => {
  it('本会话有 pending 草稿 → 恢复严格边界（等确认阶段）', async () => {
    listRoleDraftsMock.mockResolvedValue([{ sessionId: SESSION_ID, status: 'pending' }]);
    const ctx = mkCtx([
      userMsg('/create-role 股票复盘助手'),
      assistantMsg('草稿好了', ['propose_role']),
      userMsg('a'), userMsg('b'), userMsg('c'), userMsg('d'), // 已超访谈窗口，靠草稿维持
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '帮我整理今天的股票复盘报告');
    expect(result).toBe(createRoleInvocation);
  });

  it('草稿已确认/放弃（队列空）且种子滚出访谈窗口 → 不再恢复', async () => {
    const ctx = mkCtx([
      userMsg('/create-role 股票复盘助手'),
      assistantMsg('草稿好了', ['propose_role']),
      userMsg('改一下描述'), userMsg('好了'), userMsg('谢谢'),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '帮我整理今天的股票复盘报告');
    expect(result).toBeNull();
  });

  it('种子之后出现过 exit_role_flow 调用 → 即使草稿还在也不恢复', async () => {
    listRoleDraftsMock.mockResolvedValue([{ sessionId: SESSION_ID, status: 'pending' }]);
    const ctx = mkCtx([
      userMsg('/create-role 股票复盘助手'),
      assistantMsg('草稿好了', ['propose_role']),
      userMsg('帮我干点别的'),
      assistantMsg('好，先退出流程', ['exit_role_flow']),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '继续刚才的活');
    expect(result).toBeNull();
  });

  it('访谈阶段（无草稿、种子在窗口内）→ 恢复', async () => {
    const ctx = mkCtx([
      userMsg('/create-role'),
      assistantMsg('这个角色主要干什么？'),
      userMsg('帮我盯竞品'),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '再加个日报能力');
    expect(result).toBe(createRoleInvocation);
  });

  it('无草稿且种子滚出窗口（放弃访谈）→ 不恢复', async () => {
    const ctx = mkCtx([
      userMsg('/create-role'),
      userMsg('算了先不建'), userMsg('聊点别的'), userMsg('今天天气如何'),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '帮我写个周报');
    expect(result).toBeNull();
  });

  it('草稿属于其他会话 → 视同无草稿，按访谈窗口判定', async () => {
    listRoleDraftsMock.mockResolvedValue([{ sessionId: 'other-session', status: 'pending' }]);
    const ctx = mkCtx([
      userMsg('/create-role'),
      userMsg('a'), userMsg('b'), userMsg('c'),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '帮我写个周报');
    expect(result).toBeNull();
  });

  it('当前轮是斜杠命令 → 不粘滞（保持原行为）', async () => {
    listRoleDraftsMock.mockResolvedValue([{ sessionId: SESSION_ID, status: 'pending' }]);
    const ctx = mkCtx([userMsg('/create-role')]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '/help');
    expect(result).toBeNull();
  });

  it('rewound 的种子消息不算数', async () => {
    const ctx = mkCtx([
      userMsg('/create-role', { visibility: 'rewound' } as Partial<Message>),
      userMsg('随便聊聊'),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '帮我写个周报');
    expect(result).toBeNull();
  });

  it('listRoleDrafts 读盘失败 → 按无草稿处理，窗口外不恢复（不因 IO 错误锁死会话）', async () => {
    listRoleDraftsMock.mockRejectedValue(new Error('disk error'));
    const ctx = mkCtx([
      userMsg('/create-role'),
      userMsg('a'), userMsg('b'), userMsg('c'),
    ]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '帮我写个周报');
    expect(result).toBeNull();
  });
});

describe('自然语言建角色路由', () => {
  const NL = '帮我创建一个日程管家专家，负责看日历和提醒';

  it('自然语言意图 → 按 /create-role <原话> 解析出 strict 技能', async () => {
    const result = await resolveNaturalLanguageCreateRoleInvocation(mkCtx([userMsg(NL)]), NL);
    expect(result).toBe(createRoleInvocation);
    expect(resolveSkillInvocationMock).toHaveBeenCalledWith(`/create-role ${NL}`, '/tmp/wd', {
      sessionId: SESSION_ID, toolScope: undefined,
    });
  });

  it.each(['不要创建专家', '要不要创建专家', '怎么创建专家？', '删除专家', '帮我写周报', '/create-role 日历'])(
    '否定/疑问/无关/斜杠 → 不路由：%s',
    async (text) => {
      expect(await resolveNaturalLanguageCreateRoleInvocation(mkCtx([userMsg(text)]), text)).toBeNull();
      expect(resolveSkillInvocationMock).not.toHaveBeenCalled();
    },
  );

  it('技能解析不到 → null（warn 留痕）', async () => {
    resolveSkillInvocationMock.mockResolvedValue(null);
    expect(await resolveNaturalLanguageCreateRoleInvocation(mkCtx([userMsg(NL)]), NL)).toBeNull();
  });

  it('自然语言种子之后的普通回复 → 仍恢复 strict 技能（粘滞）', async () => {
    const ctx = mkCtx([userMsg(NL), assistantMsg('你想让它多久查一次日历？', ['ask_user_question'])]);
    const result = await resolveStickyStrictSkillInvocation(ctx, '每天早上八点');
    expect(result).toBe(createRoleInvocation);
    expect(resolveSkillInvocationMock).toHaveBeenCalledWith(`/create-role ${NL}`, '/tmp/wd', {
      sessionId: SESSION_ID, toolScope: undefined,
    });
  });

  it('否定句不是种子 → 不恢复', async () => {
    const ctx = mkCtx([userMsg('不要创建专家'), assistantMsg('好的')]);
    expect(await resolveStickyStrictSkillInvocation(ctx, '每天早上八点')).toBeNull();
  });
});


describe('自然语言种子使用内置技能契约', () => {
  it.each(['创建', '新建', '建立'].flatMap((verb) =>
    ['专家', '角色', '助理'].map((noun) => `帮我${verb}一个日程管家${noun}`),
  ))('%s 首轮及访谈回复恢复真实 strict 工具集', async (text) => {
    const { resolveSkillInvocationFromSkills, buildSkillInvocationContext } = await vi.importActual<
      typeof import('../../../src/host/services/skills/skillInvocationResolver')
    >('../../../src/host/services/skills/skillInvocationResolver');
    const { BUILTIN_SKILLS } = await import('../../../src/host/services/skills/builtinSkillsData');
    resolveSkillInvocationMock.mockImplementation(async (request: string) =>
      resolveSkillInvocationFromSkills(request, BUILTIN_SKILLS),
    );
    const slash = resolveSkillInvocationFromSkills(`/create-role ${text}`, BUILTIN_SKILLS);
    for (const messages of [[userMsg(text)], [userMsg(text), assistantMsg('多久检查一次？'), userMsg('每天早上')]]) {
      const invocation = await resolveStickyStrictSkillInvocation(mkCtx(messages), messages.at(-1)!.content);
      expect(invocation).toEqual(slash);
      expect(invocation?.skill.strictToolset).toBe(true);
      const context = await buildSkillInvocationContext(invocation!, '/tmp/wd');
      const slashContext = await buildSkillInvocationContext(slash!, '/tmp/wd');
      expect(context).toEqual(slashContext);
      expect(context.contextModifier.toolBoundary).toMatchObject({ skillName: 'create-role', strict: true });
      expect(context.contextModifier.toolBoundary?.allowedTools).toContain('propose_role');
    }
  });
});


describe('自然语言首轮经 sticky 路径的诊断', () => {
  const text = '帮我创建一个日程管家专家，负责看日历和提醒';

  it('记录原话和已解析技能', async () => {
    expect(await resolveStickyStrictSkillInvocation(mkCtx([userMsg(text)]), text)).toBe(createRoleInvocation);
    expect(routeLog.info).toHaveBeenCalledWith('[AgentLoop] Natural-language create-role route fired', {
      matchedText: text, resolvedSkill: 'create-role',
    });
  });

  it('技能缺失时仍通过共同路由记录可区分原因', async () => {
    resolveSkillInvocationMock.mockResolvedValue(null);
    expect(await resolveStickyStrictSkillInvocation(mkCtx([userMsg(text)]), text)).toBeNull();
    expect(routeLog.warn).toHaveBeenCalledWith(
      '[AgentLoop] Natural-language create-role route matched but create-role skill not resolvable',
      { reason: 'skill not found in discovery', matchedText: text },
    );
  });
});


describe('non-expert tasks must not activate or seed the strict flow', () => {
  it.each([
    '帮我在 postgres 里创建一个只读角色',
    '帮我创建一个 AWS IAM 角色给 Lambda 用',
    '创建一个角色，授予数据库只读权限',
    '帮我创建一个游戏角色',
    '新建一个小说里的研究员角色',
    '帮我创建一个助理网页 demo',
  ])('regular task remains outside create-role on both turns: %s', async (text) => {
    expect(await resolveNaturalLanguageCreateRoleInvocation(mkCtx([]), text)).toBeNull();
    const firstTurn = mkCtx([userMsg(text)]);
    expect(await resolveStickyStrictSkillInvocation(firstTurn, text)).toBeNull();
    const followUp = mkCtx([userMsg(text), assistantMsg('继续处理任务'), userMsg('继续')]);
    expect(await resolveStickyStrictSkillInvocation(followUp, '继续')).toBeNull();
    expect(resolveSkillInvocationMock).not.toHaveBeenCalled();
  });
});


describe('merged discovery scope is preserved across role routes', () => {
  it.each(['natural fallback', 'natural sticky', 'slash sticky'] as const)(
    'forwards session scope and honours a filtered-out skill: %s', async (route) => {
      const text = '帮我创建一个日程管家专家，负责看日历和提醒';
      const seed = route === 'slash sticky' ? `/create-role ${text}` : text;
      const toolScope = { allowedSkillIds: ['triage'] };
      const ctx = { ...mkCtx([userMsg(seed)]), toolScope };
      resolveSkillInvocationMock.mockResolvedValue(null);
      const result = route === 'natural fallback'
        ? await resolveNaturalLanguageCreateRoleInvocation(ctx, text)
        : await resolveStickyStrictSkillInvocation(ctx, '每天早上八点');
      expect(result).toBeNull();
      expect(resolveSkillInvocationMock).toHaveBeenCalledWith(`/create-role ${text}`, '/tmp/wd', {
        sessionId: SESSION_ID, toolScope,
      });
    },
  );
});
