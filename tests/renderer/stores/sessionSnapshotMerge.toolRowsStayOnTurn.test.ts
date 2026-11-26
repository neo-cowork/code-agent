import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { mergeSnapshotWithLiveTail } from '../../../src/renderer/stores/sessionSnapshotMerge';
import { groupAdjacentToolCalls } from '../../../src/renderer/utils/toolStepGrouping';

const user = (id: string, timestamp: number): Message => ({ id, timestamp, role: 'user', content: id });
const call = (id: string, success?: boolean): ToolCall => ({
  id, name: 'Read', arguments: { file_path: `${id}.txt` },
  ...(success === undefined ? {} : { result: { toolCallId: id, success, error: success ? undefined : 'File not found' } }),
});
const assistant = (id: string, timestamp: number, toolCalls: ToolCall[]): Message => ({
  id, timestamp, role: 'assistant', content: '', toolCalls,
});
const u1 = user('u1', 100);
const u2 = user('u2', 200);
const u3 = user('u3', 300);
const failed = [call('c1', false), call('c2', false)];
const snapshot = [u1, assistant('db-a1', 120, failed), u2, u3, assistant('db-a3', 320, [call('c5', true)])];
const turnsOf = (messages: Message[]) => projectTurns(messages, 'session-tools', false).turns;
const rowsOf = (messages: Message[]) => turnsOf(messages).map(turn =>
  turn.nodes.filter(node => node.type === 'tool_call').map(node => node.toolCall!.id));

describe('snapshot/live tool rows stay on their user turn', () => {
  it('does not replay first-turn failures underneath turn 3 on repeated hydration', () => {
    let live = [u1, assistant('live-a1', 110, failed), u2, u3];
    for (let reload = 0; reload < 3; reload++) {
      live = mergeSnapshotWithLiveTail(snapshot, live).messages;
      const rows = rowsOf(live);
      console.log('three-turn toolCallIds:', JSON.stringify(rows));
      expect(rows[2]).toEqual(['c5']);
      expect(rows).toEqual([['c1', 'c2'], [], ['c5']]);
      expect(new Set(rows.flat()).size).toBe(rows.flat().length);
    }
  });

  it('projects one pending approval group in turn 2 after a failed turn 1', () => {
    const pending = { ...call('approval-1'), name: 'reminders', arguments: { action: 'create', title: 'Call tomorrow' } };
    const persisted = [u1, assistant('db-a1', 120, failed), u2, assistant('db-pending', 220, [pending])];
    const live = [u1, assistant('live-a1', 110, failed), u2, assistant('live-pending', 210, [pending])];
    const merged = mergeSnapshotWithLiveTail(persisted, live).messages;
    const rows = rowsOf(merged);
    console.log('pending approval toolCallIds:', JSON.stringify(rows));
    expect(rows[1]).toEqual(['approval-1']);
    expect(rows).toEqual([['c1', 'c2'], ['approval-1']]);
    const groups = groupAdjacentToolCalls(turnsOf(merged)[1].nodes).filter(node => node.kind === 'tool_group');
    expect(groups).toHaveLength(1);
    expect(new Set(rows.flat()).size).toBe(rows.flat().length);
  });

  it('keeps a not-yet-persisted call on its earlier turn without discarding its other payloads', () => {
    const draft = {
      ...assistant('live-only', 115, [call('pending-only')]),
      content: 'Waiting for confirmation', reasoning: 'Need to read the file',
    };
    const merged = mergeSnapshotWithLiveTail(snapshot, [u1, draft, u2, u3]).messages;
    expect(rowsOf(merged)).toEqual([['c1', 'c2', 'pending-only'], [], ['c5']]);
    expect(merged.find(message => message.id === draft.id)).toEqual(draft);
  });

  it('deduplicates partially overlapping drafts and ordered parts while keeping the live result', () => {
    const persisted = [u1, assistant('db-first', 120, [call('c1')]), assistant('db-second', 125, [call('c2')]), u2];
    const draft = {
      ...assistant('live-aggregate', 110, [...failed, call('c-new')]),
      contentParts: [
        { type: 'text' as const, text: 'Retained note' },
        ...['c1', 'c2', 'c-new', 'c-new'].map(toolCallId => ({ type: 'tool_call' as const, toolCallId })),
      ],
    };
    const live = [u1, draft, u2];
    const before = structuredClone({ persisted, live });
    const merged = mergeSnapshotWithLiveTail(persisted, live).messages;
    expect(rowsOf(merged)).toEqual([['c1', 'c2', 'c-new'], []]);
    expect(merged.find(message => message.id === 'db-first')?.toolCalls?.[0].result?.success).toBe(false);
    expect(merged.find(message => message.id === draft.id)?.contentParts).toEqual([
      { type: 'text', text: 'Retained note' }, { type: 'tool_call', toolCallId: 'c-new' },
    ]);
    expect({ persisted, live }).toEqual(before);
  });
});
