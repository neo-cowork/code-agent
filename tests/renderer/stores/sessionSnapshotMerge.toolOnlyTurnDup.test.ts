import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { mergeSnapshotWithLiveTail } from '../../../src/renderer/stores/sessionSnapshotMerge';

const SESSION_ID = 'session-calendar';
const USER: Message = { id: 'user-1', role: 'user', content: '先看看日程，再读一下纪要', timestamp: 1_000 };

function toolCall(id: string, name: string, path: string, duration = 17) {
  return {
    id,
    name,
    arguments: { file_path: path },
    result: { toolCallId: id, success: true, output: 'ok', duration },
  };
}

/** 落库形状：纯工具轮 assistant 正文为空、无 correlation，配一条 tool 结果消息。 */
function persistedToolTurn(id: string, call: ReturnType<typeof toolCall>, ts: number, turnId?: string): Message[] {
  return [
    {
      id,
      role: 'assistant',
      content: '',
      timestamp: ts,
      toolCalls: [{ ...call }],
      ...(turnId ? { metadata: { correlation: { turnId } } } : {}),
    },
    { id: `${id}-result`, role: 'tool', content: '', timestamp: ts + 1, toolResults: [call.result] },
  ];
}

/** 直播形状：turn_start 建的草稿 id=turnId，只带 correlation，工具调用已有结果。 */
function liveDraft(turnId: string, call: ReturnType<typeof toolCall>, ts: number, content = ''): Message {
  return {
    id: turnId,
    role: 'assistant',
    content,
    timestamp: ts,
    toolCalls: [{ ...call }],
    metadata: { correlation: { turnId } },
  };
}

function toolRowIds(messages: Message[]): string[] {
  const projection = projectTurns(messages, SESSION_ID, true);
  return projection.turns.flatMap((turn) => turn.nodes)
    .filter((node) => node.type === 'tool_call')
    .map((node) => node.toolCall!.id);
}

describe('mid-stream reload: tool-only turns are not drawn twice', () => {
  it('one call per persisted+live pair draws one row', () => {
    const list = toolCall('call_list', 'Glob', '/ws', 14);
    const read = toolCall('call_read', 'Read', '/ws/calendar.txt', 36);
    const snapshot = [USER, ...persistedToolTurn('db-1', list, 1_100), ...persistedToolTurn('db-2', read, 1_200)];
    const live = [USER, liveDraft('turn-1', list, 1_050), liveDraft('turn-2', read, 1_150)];

    const { messages } = mergeSnapshotWithLiveTail(snapshot, live);

    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
    expect(toolRowIds(messages)).toEqual(['call_list', 'call_read']);
  });

  it('persisted rows keyed by correlation.turnId + live draft with a streamed preamble draw one row (real web run shape)', () => {
    const list = toolCall('call_list', 'Glob', '/ws', 14);
    const read = toolCall('call_read', 'Read', '/ws/calendar.txt', 36);
    const snapshot = [
      USER,
      ...persistedToolTurn('db-1', list, 1_100, 'turn-1'),
      ...persistedToolTurn('db-2', read, 1_200, 'turn-2'),
    ];
    const live = [
      USER,
      liveDraft('turn-1', list, 1_050, '先看看工作区里有哪些文件。'),
      liveDraft('turn-2', read, 1_150, '再读 calendar.txt。'),
    ];

    const { messages } = mergeSnapshotWithLiveTail(snapshot, live);

    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
    expect(toolRowIds(messages)).toEqual(['call_list', 'call_read']);
  });

  it('two different calls of the same tool name in one turn still draw two rows', () => {
    const first = toolCall('call_read_a', 'Read', '/ws/calendar.txt');
    const second = toolCall('call_read_b', 'Read', '/ws/notes.txt');
    const snapshot = [USER, ...persistedToolTurn('db-1', first, 1_100), ...persistedToolTurn('db-2', second, 1_200)];
    const live = [USER, liveDraft('turn-1', first, 1_050), liveDraft('turn-2', second, 1_150)];

    const { messages } = mergeSnapshotWithLiveTail(snapshot, live);

    expect(toolRowIds(messages)).toEqual(['call_read_a', 'call_read_b']);
  });

  it('a live-only draft with a different call id is kept (not swallowed by an unrelated snapshot message)', () => {
    const persisted = toolCall('call_read_a', 'Read', '/ws/calendar.txt');
    const inFlight = toolCall('call_read_b', 'Read', '/ws/notes.txt');
    const snapshot = [USER, ...persistedToolTurn('db-1', persisted, 1_100)];
    const live = [USER, liveDraft('turn-1', persisted, 1_050), liveDraft('turn-2', inFlight, 1_150)];

    const { messages } = mergeSnapshotWithLiveTail(snapshot, live);

    expect(toolRowIds(messages)).toEqual(['call_read_a', 'call_read_b']);
  });
});
