// ============================================================================
// N-PERM-NL-RULES-K2 返修（PR #2911 Important 1）— preapprove 的「发起话」只认用户原话
// ----------------------------------------------------------------------------
// 缺陷：run 盖章用的是模型面请求（系统脚手架 + <user_request> 包裹），角色资料块/
// 通话告知/能力告知里出现触发短语就免审批放行。修法：发起话由 resolveRunInitiatingText
// 按「谁写的」定值——用户在聊天里打的字、或生产者显式声明的用户文本；其余一律没有
// 发起话（preapprove 回落询问，绝不静默放行）。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { beginRunPolicy, endRunPolicy } from '../../../src/host/permissions/runPolicySnapshot';
import { resolveUserRuleOutcomeForTool } from '../../../src/host/permissions/userRuleOutcome';
import {
  resolveRunInitiatingText,
  stampInputProvenance,
} from '../../../src/host/permissions/runInitiatingText';
import { wrapWithTurnSystemContext } from '../../../src/shared/utils/turnScaffold';
import type { AgentRunOptions } from '../../../src/host/research/types';

// 生产调用方（agentOrchestrator / web 路由）传的是整份 AgentRunOptions。两个函数的形参是
// 它的窄子集（Pick）与泛型，直接传对象字面量会被多余属性检查/字面量推断拦下；这里用
// 同一份 AgentRunOptions 类型的薄包装，测试按生产的传法写。
const resolveText = (content: string, options?: AgentRunOptions): string | undefined =>
  resolveRunInitiatingText(content, options);
const stamp = (
  options: AgentRunOptions | undefined,
  messageMetadata: Parameters<typeof stampInputProvenance>[1],
): AgentRunOptions | undefined => stampInputProvenance(options, messageMetadata);

const PHRASE = '照常发周报';
const RUN = 'k2-init-run';
const SESSION = 'k2-init-session';

describe('resolveRunInitiatingText：按来源定值', () => {
  it('普通聊天消息 → 用户原话', () => {
    expect(resolveText(`${PHRASE}吧`, { mode: 'normal' })).toBe(`${PHRASE}吧`);
    expect(resolveText('随便聊聊', undefined)).toBe('随便聊聊');
  });

  it('模型面包装（系统上下文 + <user_request>）→ 只取用户那一段', () => {
    const wrapped = wrapWithTurnSystemContext([`<role_context>资料：${PHRASE}</role_context>`], '只是打个招呼');
    expect(resolveText(wrapped, { mode: 'normal' })).toBe('只是打个招呼');
  });

  it('renderer 预置的 <system-reminder> 块不算用户的话', () => {
    const content = `<system-reminder kind="design-code-handoff-json">${PHRASE}</system-reminder>\n帮我看看这个页面`;
    expect(resolveText(content, { mode: 'normal' })).toBe('帮我看看这个页面');
  });

  it.each([
    ['自动化输入（唤醒/角色主动性/loop）', { mode: 'normal', inputSource: 'automation' }],
    ['整轮隐藏的系统轮', { mode: 'normal', historyVisibility: 'meta' }],
    ['只隐藏输入的系统轮（后台子代理回报等）', { mode: 'normal', inputHistoryVisibility: 'meta' }],
    ['恢复既有 durable run', { mode: 'normal', resumeExistingDurableRun: true }],
    ['展示文案与模型输入分离（工作卡）', { mode: 'normal', displayContent: '@neo 做周报' }],
  ] as const)('%s → 没有发起话', (_label, options) => {
    expect(resolveText(`系统生成的提示词，里面带着 ${PHRASE}`, options)).toBeUndefined();
  });

  it('生产者声明的用户文本优先于一切推断（定时任务的提示词正文）', () => {
    expect(resolveText(
      `${PHRASE}\n\n<previous_snapshot>上次的模型输出</previous_snapshot>`,
      { mode: 'normal', inputSource: 'automation', initiatingUserText: PHRASE },
    )).toBe(PHRASE);
  });

  it('显式 null = 明确没有用户原话，即使 content 里有短语', () => {
    expect(resolveText(PHRASE, { mode: 'normal', initiatingUserText: null })).toBeUndefined();
  });

  it('空白发起话 → undefined（不留空串盖章）', () => {
    expect(resolveText('   ', { mode: 'normal' })).toBeUndefined();
  });
});

describe('stampInputProvenance：消息元数据里的来源', () => {
  it('IM 通道消息（发言人身份无从核实）→ 强制没有发起话，声明也不认', () => {
    const channel = { platform: 'feishu', accountId: 'a', chatId: 'c' };
    expect(stamp({ mode: 'normal' }, { channel })?.initiatingUserText).toBeNull();
    expect(stamp({ mode: 'normal', initiatingUserText: PHRASE }, { channel })?.initiatingUserText).toBeNull();
    expect(stamp(undefined, { channel })?.initiatingUserText).toBeNull();
  });

  it('同条消息带外部载荷（memoryTainted）且生产者没声明 → 没有发起话', () => {
    expect(stamp({ mode: 'normal' }, { memoryTainted: true })?.initiatingUserText).toBeNull();
  });

  it('带外部载荷但生产者声明了用户文本 → 保留声明（载荷不在声明里）', () => {
    expect(stamp({ mode: 'normal', initiatingUserText: PHRASE }, { memoryTainted: true })?.initiatingUserText)
      .toBe(PHRASE);
  });

  it('普通消息 → options 原样返回（同一引用，不凭空造对象）', () => {
    const options = { mode: 'normal' as const };
    expect(stamp(options, undefined)).toBe(options);
    expect(stamp(undefined, {})).toBeUndefined();
  });
});

describe('端到端：短语只出现在系统注入块里 → 不免审批（真 PolicyEngine + 真消费端）', () => {
  beforeEach(() => {
    resetPolicyEngine();
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'preapprove', rule: 'Bash(npm publish *)', phrases: [PHRASE] }],
    });
  });

  afterEach(() => {
    endRunPolicy(RUN);
    resetPolicyEngine();
  });

  function outcomeFor(content: string, options?: AgentRunOptions) {
    beginRunPolicy(RUN, SESSION, { initiatingText: resolveText(content, options) });
    return resolveUserRuleOutcomeForTool(SESSION, 'Bash', { command: 'npm publish --tag weekly' });
  }

  it('用户没说短语、角色资料块里有 → 回落 ask', () => {
    // 即便整段模型面请求被当成 content 传进来（排队 steer 的恢复路径），也只取用户那段。
    const wrapped = wrapWithTurnSystemContext([`<role_context>${PHRASE}</role_context>`], '只是打个招呼');
    expect(outcomeFor(wrapped, { mode: 'normal' }).kind).toBe('ask');
  });

  it('用户亲口说了短语 → 免询问', () => {
    const content = `${PHRASE}，辛苦了`;
    expect(outcomeFor(content, { mode: 'normal' })).toEqual({
      kind: 'preapproved', rule: 'Bash(npm publish *)', phrase: PHRASE,
    });
  });

  it('自动化轮的提示词带短语但没声明用户文本 → 回落 ask', () => {
    const content = `后台子代理回报：${PHRASE}`;
    expect(outcomeFor(content, { mode: 'normal', inputSource: 'automation' }).kind).toBe('ask');
  });
});
