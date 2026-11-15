// N-FIX-AGENT-ERROR-CARD-STICKS-TO-LATER-TURNS：前两轮模型鉴权失败、后两轮成功。
// 失败时 renderer 自补 `agent-error-<ts>` 承载错误卡，落库那条失败消息是另一个 id、正文为空。
// 快照与 live 合并配不上时，live 那条被追加到尾部、挂进最新的成功轮——每轮都夹一张「这个模型用不了」。
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { mergeSnapshotWithLiveTail } from '../../../src/renderer/stores/sessionSnapshotMerge';

const authError = (timestamp: number) => ({
  agentError: { category: 'auth' as const, rawMessage: 'Responses API (401): invalid api key', timestamp, httpStatus: 401 },
});
const user = (id: string, timestamp: number): Message => ({ id, role: 'user', content: '我今天有什么日程', timestamp });

// 落库形状（取自现场会话 session_1794719544214_40b973d2，去掉无关字段）
const snapshot: Message[] = [
  user('u1', 100),
  { id: 'sys1', role: 'system', content: '<failed-run-continuation-context/>', timestamp: 110, isMeta: true },
  { id: 'db-fail-1', role: 'assistant', content: '', timestamp: 120, metadata: authError(119) },
  user('u2', 200),
  { id: 'sys2', role: 'system', content: '<failed-run-continuation-context/>', timestamp: 210, isMeta: true },
  { id: 'db-fail-2', role: 'assistant', content: '', timestamp: 220, metadata: authError(219) },
  user('u3', 300),
  {
    id: 'a3-tool', role: 'assistant', content: '', timestamp: 310,
    toolCalls: [{ id: 'tc3', name: 'calendar', arguments: {}, result: { toolCallId: 'tc3', success: true, output: '[]' } }],
    metadata: { correlation: { turnId: 'turn-3' } },
  },
  { id: 'a3-final', role: 'assistant', content: '今天没有日程。', timestamp: 320, metadata: { correlation: { turnId: 'turn-3' } } },
  user('u4', 400),
  {
    id: 'a4-tool', role: 'assistant', content: '', timestamp: 410,
    toolCalls: [{ id: 'tc4', name: 'calendar', arguments: {}, result: { toolCallId: 'tc4', success: true, output: '[]' } }],
    metadata: { correlation: { turnId: 'turn-4' } },
  },
  { id: 'a4-final', role: 'assistant', content: '日历里今天没有安排。', timestamp: 420, metadata: { correlation: { turnId: 'turn-4' } } },
];

// renderer 内存：失败卡挂在 attachAgentErrorToLatestAssistant 自补的消息上
const liveFailures: Message[] = [
  user('u1', 100),
  { id: 'agent-error-119', role: 'assistant', content: '', timestamp: 119, metadata: authError(119) },
  user('u2', 200),
  { id: 'agent-error-219', role: 'assistant', content: '', timestamp: 219, metadata: authError(219) },
];

function errorTurns(messages: Message[]) {
  return projectTurns(messages, 'session-1', false).turns
    .map((turn, index) => ({ index, errors: turn.nodes.filter((node) => node.metadata?.agentError).length }))
    .filter((turn) => turn.errors > 0)
    .map((turn) => turn.index);
}

describe('失败卡只留在失败轮', () => {
  it('重新加载（纯快照投影）：错误卡只在第 1、2 轮', () => {
    expect(errorTurns(snapshot)).toEqual([0, 1]);
  });

  it('live 自补失败消息与快照多次合并后，成功轮下面没有错误卡', () => {
    // 第 3 轮跑到工具调用时会话重灌一次，第 4 轮结束再重灌一次
    let live = [...liveFailures, ...snapshot.slice(6, 8)];
    live = mergeSnapshotWithLiveTail(snapshot.slice(0, 8), live).messages;
    expect(errorTurns(live)).toEqual([0, 1]);
    live = mergeSnapshotWithLiveTail(snapshot, [...live, ...snapshot.slice(8)]).messages;
    expect(errorTurns(live)).toEqual([0, 1]);
    expect(live.filter((message) => message.metadata?.agentError)).toHaveLength(2);
  });
});
