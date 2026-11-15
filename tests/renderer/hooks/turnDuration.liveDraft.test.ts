// N-FIX-TURN-DURATION-ZERO-AND-SENDING-OVERLAP：工具跑了 5.7 秒、这一轮却显示「用时 0s」。
// turn_start 建的流式草稿打的是开轮时间，整轮（工具调用 + 最终回复）都 commit 到这一条草稿上；
// 投影取末节点时间戳当 endTime，于是 endTime === startTime。会话重灌时快照合并又用 live 的
// 开轮时间盖掉落库终稿的写入时间，同样回到 0s。
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { applyConversationStreamEvent } from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { mergeSnapshotWithLiveTail } from '../../../src/renderer/stores/sessionSnapshotMerge';

const SEND = 1_000;
const TOOL_DONE = 6_700;
const FINAL = 15_000;

function lastTurnDuration(messages: Message[]): number | null {
  const turn = projectTurns(messages, 'session-1', false).turns.at(-1)!;
  return turn.endTime === undefined ? null : turn.endTime - turn.startTime;
}

describe('轮次用时覆盖工具与最终回复', () => {
  it('live：草稿随 commit 推进时间戳，用时不再是 0s', () => {
    const messagesRef = { current: [{ id: 'u1', role: 'user', content: '读一下 README', timestamp: SEND } as Message] };
    let clock = SEND;
    const actions = {
      addMessage: (message: Message) => { messagesRef.current = [...messagesRef.current, message]; },
      updateMessage: (id: string, changes: Partial<Message>) => {
        messagesRef.current = messagesRef.current.map((m) => (m.id === id ? { ...m, ...changes } : m));
      },
      setMessages: (next: Message[]) => { messagesRef.current = next; },
      getMessages: () => messagesRef.current,
      queueUpdate: () => {},
      now: () => clock,
    };
    const state = {
      currentTurnMessageId: null,
      committedAssistantMessageIds: new Set<string>(),
      lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
    };

    applyConversationStreamEvent({ type: 'turn_start', data: { turnId: 'turn-1', iteration: 1 } }, state, actions);
    clock = TOOL_DONE;
    applyConversationStreamEvent({
      type: 'message',
      data: {
        id: 'turn-1', turnId: 'turn-1', role: 'assistant', content: '',
        toolCalls: [{ id: 'tc1', name: 'Read', arguments: { path: 'README.md' } }],
      },
    }, state, actions);
    clock = FINAL;
    applyConversationStreamEvent({
      type: 'message',
      data: { id: 'turn-1', turnId: 'turn-1', role: 'assistant', content: 'README 讲的是安装步骤。' },
    }, state, actions);

    expect(lastTurnDuration(messagesRef.current)).toBe(FINAL - SEND);
  });

  it('重灌：快照合并保留落库终稿的写入时间，不被 live 草稿的开轮时间盖掉', () => {
    const correlation = { correlation: { turnId: 'turn-1' } };
    const snapshot: Message[] = [
      { id: 'u1', role: 'user', content: '读一下 README', timestamp: SEND },
      {
        id: 'db-tool', role: 'assistant', content: '', timestamp: SEND + 700, metadata: correlation,
        toolCalls: [{ id: 'tc1', name: 'Read', arguments: {}, result: { toolCallId: 'tc1', success: true, output: '# README' } }],
      },
      { id: 'db-final', role: 'assistant', content: 'README 讲的是安装步骤。', timestamp: FINAL, metadata: correlation },
    ];
    // live 草稿是 turn_start 建的，时间戳停在开轮时刻
    const live: Message[] = [
      snapshot[0],
      { id: 'turn-1', role: 'assistant', content: 'README 讲的是安装步骤。', timestamp: SEND, metadata: correlation },
    ];

    expect(lastTurnDuration(mergeSnapshotWithLiveTail(snapshot, live).messages)).toBe(FINAL - SEND);
  });
});
