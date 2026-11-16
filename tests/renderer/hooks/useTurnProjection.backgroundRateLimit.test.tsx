// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { Message } from '../../../src/shared/contract';
import { classifyAgentError } from '../../../src/shared/utils/agentErrorClassification';
import { useTurnProjection } from '../../../src/renderer/hooks/useTurnProjection';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { AgentErrorPresentation } from '../../../src/renderer/components/features/chat/AgentErrorCard';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const summary = '您的账户已达到速率限制，请您控制请求频率';
function fixture(childrenWithError: boolean[] = [false, false, false]): Message[] {
  return childrenWithError.flatMap((childError, i): Message[] => [
    { id: `u${i}`, role: 'user', content: `打开 example.com，告诉我标题，第 ${i + 1} 次`, timestamp: i * 100 },
    { id: `pre${i}`, role: 'assistant', content: '我先交给后台执行。', timestamp: i * 100 + 1,
      metadata: { backgroundTaskPreannounce: { text: '我先交给后台执行。' } } },
    { id: `child${i}`, role: 'user', content: '内部子任务指令', isMeta: true, timestamp: i * 100 + 2 },
    ...(childError ? [{ id: `err${i}`, role: 'assistant' as const, content: '', timestamp: i * 100 + 3,
      metadata: { agentError: classifyAgentError({ message: summary })! } }] : []),
    { id: `result${i}`, role: 'system', content: '', timestamp: i * 100 + 4,
      metadata: { backgroundTaskResult: { source: 'agent-result', taskId: `task${i}`, shortName: '查看网页标题', status: 'failed', summary } } },
    { id: `wake${i}`, role: 'user', content: '后台任务已失败，结果摘要', isMeta: true, timestamp: i * 100 + 5 },
  ]);
}
function view(messages: Message[]) {
  const { result } = renderHook(() => useTurnProjection(messages, 'background-rate', false));
  const nodes = result.current.turns.flatMap(t => t.nodes).filter(n => n.metadata?.agentError);
  return <>{nodes.map(n => <AgentErrorPresentation key={n.id} error={n.metadata!.agentError!}
    messageId={n.messageId ?? n.id} sessionId="background-rate" run={n.agentErrorRun} />)}</>;
}
function counts() {
  return { full: screen.queryAllByRole('alert').length,
    muted: screen.queryAllByTestId('agent-error-muted-line').length,
    rate: screen.queryAllByTestId('rate-limited-error-line').length };
}
describe('background rate limits by visible user turn', () => {
  beforeEach(() => {
    useAppStore.setState({ language: 'zh', processingSessionIds: new Set(), disclosureLevel: 'simple' });
    useSessionStore.setState({ currentSessionId: 'background-rate', runningSessionIds: new Set() });
  });
  afterEach(() => { cleanup(); useMessageActionStore.getState().unregister(); });
  it.each([{ shape: [false, false, false] }, { shape: [true, false, true] }])('② three visible turns, child errors $shape', ({ shape }) => {
    const messages = fixture(shape);
    const persisted = JSON.stringify(messages);
    render(view(messages));
    console.log('BACKGROUND_COUNTS', JSON.stringify(counts()));
    expect(counts()).toEqual({ full: 0, muted: 2, rate: 1 });
    expect(JSON.stringify(messages)).toBe(persisted);
  });
  it.each([false, true])('② TurnCard collapsed/expanded=%s keeps one latest line and two muted lines', expanded => {
    const messages = fixture().flatMap(m => m.id.startsWith('pre') ? [
      { id: `${m.id}-progress`, role: 'assistant' as const, content: '正在查看页面。', timestamp: m.timestamp - 0.5 }, m] : [m]);
    const { result } = renderHook(() => useTurnProjection(messages, 'background-rate', false));
    render(<>{result.current.turns.map(turn => <TurnCard key={turn.turnId} turn={turn}
      sessionId="background-rate" defaultExpanded={expanded} forceExpanded={expanded} />)}</>);
    expect(screen.getAllByTitle(expanded ? '折叠本轮' : '展开本轮')).toHaveLength(3);
    expect(counts()).toEqual({ full: 0, muted: 2, rate: 1 });
  });
  it.each([false, true])('③ later successful parent reply suppresses child failure (child error %s)', childError => {
    const messages = fixture([childError]);
    messages.push({ id: 'parent-success', role: 'assistant', content: '页面标题是 Example Domain。', timestamp: 10 });
    const persisted = JSON.stringify(messages);
    render(view(messages));
    expect(counts()).toEqual({ full: 0, muted: 0, rate: 0 });
    expect(JSON.stringify(messages)).toBe(persisted);
    expect(messages.filter(m => m.id === 'parent-success')[0].metadata?.agentError).toBeUndefined();
  });
  it.each([false, true])('④ two independent failed children count once (child error %s)', childError => {
    const messages = fixture([childError, childError]).filter(m => m.id !== 'u1');
    render(view(messages));
    expect(counts()).toEqual({ full: 0, muted: 0, rate: 1 });
  });
  it('⑤ clicking latest rate line resends latest visible sentence, skipping child and wake prompts', () => {
    const messages = fixture();
    const send = vi.fn();
    useMessageActionStore.getState().register(send, () => messages);
    render(view(messages));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(send).toHaveBeenCalledExactlyOnceWith('打开 example.com，告诉我标题，第 3 次');
  });
  it.each(['completed', 'cancelled', 'unverified'] as const)('mixed child status %s must not imply all children were rate limited', status => {
    const messages = fixture([false, false]).filter(m => m.id !== 'u1');
    messages.find(m => m.id === 'result1')!.metadata!.backgroundTaskResult!.status = status;
    render(view(messages));
    expect(counts()).toEqual({ full: 0, muted: 0, rate: 0 });
  });
  it('pending independent child prevents an all-failed aggregate', () => {
    const messages = fixture([false]);
    messages.splice(1, 0, { id: 'delegating', role: 'assistant', content: '', timestamp: 1,
      toolCalls: [{ id: 'pending-call', name: 'delegate_task', arguments: { prompt: '查看另一个网页标题' } }] });
    render(view(messages));
    expect(counts()).toEqual({ full: 0, muted: 0, rate: 0 });
  });
  it('⑤ late result belongs to its starting turn and retry uses that turn', () => {
    const messages = fixture([false]);
    const result = messages.splice(messages.findIndex(m => m.id === 'result0'), 1)[0];
    messages.splice(1, 0,
      { id: 'delegate', role: 'assistant', content: '', timestamp: 1,
        toolCalls: [{ id: 'call', name: 'delegate_task', arguments: {} }] },
      { id: 'accepted', role: 'tool', content: '', timestamp: 2, toolResults: [{ toolCallId: 'call', success: true, output: '',
        metadata: { sessionTask: { outcome: 'accepted', tasks: [{ taskId: 'task0' }] } } }] });
    messages.push({ id: 'next-user', role: 'user', content: '另一个问题', timestamp: 20 },
      { id: 'next-answer', role: 'assistant', content: '另一个问题的回答。', timestamp: 21 },
      { ...result, timestamp: 30 });
    const send = vi.fn();
    useMessageActionStore.getState().register(send, () => messages);
    render(view(messages));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(send).toHaveBeenCalledExactlyOnceWith('打开 example.com，告诉我标题，第 1 次');
  });
  it('⑦ three foreground failures remain two muted lines and one rate line', () => {
    const messages = fixture([true, true, true]).filter(m => m.role === 'user' && !m.isMeta || m.metadata?.agentError);
    render(view(messages));
    expect(counts()).toEqual({ full: 0, muted: 2, rate: 1 });
  });
});
