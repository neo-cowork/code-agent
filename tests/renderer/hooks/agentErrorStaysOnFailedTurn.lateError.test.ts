// N-FIX-STALE-FAILURE-CARD-SHOWN-ON-NEW-TURN：第 1 轮鉴权失败，用户换模型发第 2 轮。
// 失败卡必须留在失败那一轮，晚到/重复的第 1 轮终态 error 不能把卡挂到第 2 轮下面。
import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { mergeSnapshotWithLiveTail } from '../../../src/renderer/stores/sessionSnapshotMerge';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { attachAgentErrorToLatestAssistant } from '../../../src/renderer/hooks/agent/effects/useSessionLifecycleEffects';
import { classifyAgentError } from '../../../src/shared/utils/agentErrorClassification';

const authPayload = {
  code: 'RUN_FAILED',
  message: 'Responses API (401): invalid api key',
  httpStatus: 401,
  failure: { code: 'MODEL_AUTH' },
};
const user = (id: string, timestamp: number, content = '我今天有什么日程'): Message => ({ id, role: 'user', content, timestamp });

function errorTurns(messages: Message[]) {
  return projectTurns(messages, 'session-1', false).turns
    .map((turn, index) => ({ index, errors: turn.nodes.filter((node) => node.metadata?.agentError).length }))
    .filter((turn) => turn.errors > 0)
    .map((turn) => turn.index);
}

function setMessages(messages: Message[]) {
  useSessionStore.setState({ messages, currentSessionId: 'session-1' } as never);
}
const messagesNow = () => useSessionStore.getState().messages;

describe('失败卡只留在失败轮（晚到 error / 合并变体）', () => {
  beforeEach(() => setMessages([]));

  it('第 1 轮失败后第 2 轮已开始，第 1 轮的重复终态 error 到达：不得在第 2 轮下新增失败卡', () => {
    setMessages([user('u1', 100)]);
    const first = classifyAgentError(authPayload, { modelId: 'bad' })!;
    attachAgentErrorToLatestAssistant(first);
    // 用户换模型，第 2 轮开始（用户消息 + turn_start 草稿）
    useSessionStore.getState().addMessage(user('u2', 200, '另一个问题'));
    // 第 1 轮另一个出口的终态 error 此时才到（host 带着第 1 轮的 userMessageId）
    const late = classifyAgentError({ ...authPayload, details: { turnUserMessageId: 'u1' } }, { modelId: 'good' })!;
    attachAgentErrorToLatestAssistant(late, 'u1');
    expect(errorTurns(messagesNow())).toEqual([0]);
  });

  it('第 2 轮自己真失败：卡挂在第 2 轮（带或不带轮次标记都一样）', () => {
    setMessages([user('u1', 100)]);
    attachAgentErrorToLatestAssistant(classifyAgentError(authPayload)!, 'u1');
    useSessionStore.getState().addMessage(user('u2', 200, '另一个问题'));
    attachAgentErrorToLatestAssistant(classifyAgentError(authPayload)!, 'u2');
    expect(errorTurns(messagesNow())).toEqual([0, 1]);
    setMessages([user('u1', 100), user('u2', 200)]);
    attachAgentErrorToLatestAssistant(classifyAgentError(authPayload)!);
    expect(errorTurns(messagesNow())).toEqual([1]);
  });

  it('第 2 轮成功后晚到第 1 轮 error：卡落回第 1 轮，第 2 轮的回复不被污染', () => {
    setMessages([
      user('u1', 100),
      user('u2', 200, '另一个问题'),
      { id: 'a2', role: 'assistant', content: '三个好习惯……', timestamp: 210 },
    ]);
    attachAgentErrorToLatestAssistant(classifyAgentError(authPayload)!, 'u1');
    expect(errorTurns(messagesNow())).toEqual([0]);
    expect(messagesNow().find((m) => m.id === 'a2')?.metadata?.agentError).toBeUndefined();
    expect(messagesNow().map((m) => m.id).slice(0, 2)).toEqual(['u1', expect.stringMatching(/^agent-error-/)]);
  });

  it('快照落库的失败消息 + live 第 2 轮草稿（无 correlation）合并后卡仍在第 1 轮', () => {
    const err = classifyAgentError(authPayload)!;
    const snapshot: Message[] = [
      user('u1', 100),
      { id: 'db-fail-1', role: 'assistant', content: '', timestamp: 120, metadata: { agentError: err } },
      user('u2', 200, '另一个问题'),
    ];
    const live: Message[] = [
      user('u1', 100),
      { id: 'agent-error-1', role: 'assistant', content: '', timestamp: 119, metadata: { agentError: err } },
      user('u2', 200, '另一个问题'),
      { id: 'draft-2', role: 'assistant', content: '', timestamp: 210 },
    ];
    expect(errorTurns(mergeSnapshotWithLiveTail(snapshot, live).messages)).toEqual([0]);
  });
});
