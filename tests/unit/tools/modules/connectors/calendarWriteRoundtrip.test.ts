// 真机第三轮：create 回的 uid 模型拿不到 → 照别的日程拼了假 uid；删除走了红色通用卡、删了收不回。
// 这里用真工具模块 + 真日历连接器 + 假原生桥（照 Rust 路由行为），锁住：
//   ① create 输出里的 uid 原样可用于 update / delete，list 给的是同一种形式；
//   ② 删除批准时卡片拿到的是要删那条的标题/时间/日历，删除请求本身不带这些；
//   ③ 删后「撤销」按会话 + 工具调用 id 用宿主自存的快照重建，重复点击不会建两条。
// Evidence class: hermetic-protocol.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import type { Message } from '../../../../../src/shared/contract';

const { fake } = await vi.hoisted(async () => ({ fake: (await import('../../../connectors/fakeCalendarBridge')).createFakeCalendarBridge() }));
vi.mock('../../../../../src/host/permissions/envAssist/shellBridge/client', async (orig) => ({
  ...(await orig<object>()), resolveShellBridgeClientFromEnv: () => fake.client,
}));
const store = vi.hoisted(() => ({ messages: [] as Message[], updates: [] as Array<{ id: string; updates: Partial<Message> }> }));
vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async () => store.messages.map((m) => structuredClone(m)),
    updateMessage: async (id: string, updates: Partial<Message>) => {
      store.updates.push({ id, updates });
      const m = store.messages.find((x) => x.id === id);
      if (m) Object.assign(m, updates);
    },
  }),
}));
vi.mock('../../../../../src/host/connectors', async (orig) => {
  const { calendarConnector } = await import('../../../../../src/host/connectors/native/calendar');
  return { ...(await orig<object>()), getConnectorRegistry: () => ({ get: (id: string) => (id === 'calendar' ? calendarConnector : undefined) }) };
});

import { calendarConnector, resetCalendarConnectorReadiness } from '../../../../../src/host/connectors/native/calendar';
import { calendarCreateEventModule } from '../../../../../src/host/tools/modules/connectors/calendarCreateEvent';
import { calendarUpdateEventModule } from '../../../../../src/host/tools/modules/connectors/calendarUpdateEvent';
import { calendarDeleteEventModule } from '../../../../../src/host/tools/modules/connectors/calendarDeleteEvent';
import { calendarModule } from '../../../../../src/host/tools/modules/connectors/calendar';
import { undoCalendarDelete } from '../../../../../src/host/tools/modules/connectors/calendarUndo';
import { calendarApprovalDetails } from '../../../../../src/host/tools/modules/connectors/calendarApprovalDetails';
import { useDarwinPlatform } from '../../../connectors/fakeCalendarBridge';

useDarwinPlatform();
const HOUR = 3_600_000;
const ctx = () => ({
  sessionId: 's', workingDir: process.cwd(), abortSignal: new AbortController().signal, emit: () => undefined,
  logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as Logger,
}) as unknown as ToolContext;
const allow: CanUseToolFn = async () => ({ allow: true });
const run = async (mod: { createHandler(): unknown }, args: Record<string, unknown>, can: CanUseToolFn = allow) =>
  (await (mod.createHandler() as { execute: (...a: unknown[]) => Promise<{ ok: boolean; output?: string; meta?: Record<string, unknown>; error?: string }> }).execute(args, ctx(), can));
const uidIn = (output: string | undefined) => /uid: (\S+)/.exec(output ?? '')?.[1];

beforeEach(() => {
  fake.reset();
  fake.state.calendars = [{ id: 'cal-id-8012', title: '日历', writable: true, isDefault: true }];
  resetCalendarConnectorReadiness();
  store.messages.length = 0;
  store.updates.length = 0;
});

describe('calendar write round trip (EventKit)', () => {
  it('① the uid create prints is the uid list prints, and works as-is for update and delete', async () => {
    const created = await run(calendarCreateEventModule, { title: 'F 真机测试', start_ms: HOUR, end_ms: 2 * HOUR, location: '三楼' });
    expect(created.ok).toBe(true);
    const uid = uidIn(created.output);
    expect(uid).toBeTruthy();
    expect(uid).not.toContain('@'); // a one-off event never gets the occurrence suffix

    const listed = await run(calendarModule, { action: 'list_events', from_ms: 0, to_ms: 3 * HOUR });
    expect(uidIn(listed.output)).toBe(uid);

    const updated = await run(calendarUpdateEventModule, { calendar: '日历', event_uid: uid, location: '五楼会议室' });
    expect(updated.ok).toBe(true);
    expect(uidIn(updated.output)).toBe(uid);
    expect(fake.state.items[0].location).toBe('五楼会议室');

    const deleted = await run(calendarDeleteEventModule, { calendar: '日历', event_uid: uid });
    expect(deleted.ok).toBe(true);
    expect(fake.state.items).toEqual([]);
  });

  it('② one approval only: the card details come from the pre-execution approval; the handler asks with the exact model args (so the top-level grant short-circuits)', async () => {
    fake.state.items.push({ id: 'cal-id-8012:EV1', calendarId: 'cal-id-8012', calendar: '日历', title: '评审', startMs: HOUR, endMs: 2 * HOUR, location: '三楼', notes: '带材料' });
    // What the single top-level approval card shows (merged into its details by toolExecutor).
    expect(await calendarApprovalDetails('calendar_delete_event', { calendar: '日历', event_uid: 'cal-id-8012:EV1' }))
      .toEqual({ calendar: '日历', title: '评审', start_ms: HOUR, end_ms: 2 * HOUR, location: '三楼' });
    expect(await calendarApprovalDetails('calendar_create_event', { title: 'x', start_ms: 1 })).toEqual({ calendar: '日历' });
    expect(await calendarApprovalDetails('calendar_create_event', { title: 'x', start_ms: 1, calendar: 'Work' })).toEqual({});
    expect(await calendarApprovalDetails('calendar_update_event', { calendar: '日历', event_uid: 'cal-id-8012:EV1', start_ms: 3 * HOUR }))
      .toEqual({ title: '评审', end_ms: 2 * HOUR, location: '三楼' });
    // 11-16 real run: a handler asking with different args than the approved ones raised a second card.
    const toolSource = readFileSync('src/host/tools/toolExecutor.ts', 'utf8');
    const merged = toolSource.indexOf('calendarApprovalDetails(executionToolName, params)');
    expect(merged).toBeGreaterThan(0);
    expect(merged).toBeLessThan(toolSource.indexOf('getDenialRegistry().observeApproval'));
    const asked: Array<Record<string, unknown>> = [];
    const askSpy: CanUseToolFn = async (_t, args) => { asked.push(args as Record<string, unknown>); return { allow: true }; };
    await run(calendarCreateEventModule, { title: '新会', start_ms: HOUR }, askSpy);
    const result = await run(calendarDeleteEventModule, { calendar: '日历', event_uid: 'cal-id-8012:EV1' }, askSpy);
    expect(result.ok).toBe(true);
    expect(asked).toEqual([{ title: '新会', start_ms: HOUR }, { calendar: '日历', event_uid: 'cal-id-8012:EV1' }]);
    expect(fake.state.calls.filter((c) => c.path === '/v1/write/calendar-event').at(-1)?.body).toEqual({ op: 'delete', eventId: 'cal-id-8012:EV1' });
    expect(result.meta).toMatchObject({ undoable: true, before: { title: '评审', notes: '带材料', calendar: '日历' } });
  });

  it('update enrichment fills only missing keys, including the authoritative calendar, without mutating model args', async () => {
    fake.state.items.push({ id: 'cal-id-8012:EV1', calendarId: 'cal-id-8012', calendar: '日历', title: '评审', startMs: HOUR, endMs: 2 * HOUR, location: '三楼' });
    const args = Object.freeze({ calendar: '日历', event_uid: 'cal-id-8012:EV1', start_ms: 3 * HOUR });
    expect(await calendarApprovalDetails('calendar_update_event', args))
      .toEqual({ title: '评审', end_ms: 2 * HOUR, location: '三楼' });
    expect(args).toEqual({ calendar: '日历', event_uid: 'cal-id-8012:EV1', start_ms: 3 * HOUR });
    const explicit = { ...args, calendar: '日历', title: '新标题', end_ms: 4 * HOUR, location: '' };
    expect(await calendarApprovalDetails('calendar_update_event', explicit)).toEqual({});
    expect(fake.state.calls.at(-1)).toMatchObject({ path: '/v1/read/calendar-event', body: { eventId: args.event_uid } });
  });

  it('update projects the get_event calendar name when the model did not supply a calendar', async () => {
    const execute = vi.spyOn(calendarConnector, 'execute').mockResolvedValue({ data: {
      calendar: 'Work', title: 'Quarterly review', startAtMs: HOUR, endAtMs: 2 * HOUR, location: '',
    } });
    try {
      expect(await calendarApprovalDetails('calendar_update_event', { event_uid: 'event-1' }))
        .toEqual({ calendar: 'Work', title: 'Quarterly review', start_ms: HOUR, end_ms: 2 * HOUR });
      // Even an incorrect calendar stays model-supplied; enrichment must not redirect a write.
      expect(await calendarApprovalDetails('calendar_update_event', { event_uid: 'event-1', calendar: 'Quarterly review' }))
        .toEqual({ title: 'Quarterly review', start_ms: HOUR, end_ms: 2 * HOUR });
    } finally {
      execute.mockRestore();
    }
  });

  it('a failed get_event leaves update approval usable and does not request native permission', async () => {
    const args = Object.freeze({ calendar: '日历', event_uid: 'missing', start_ms: 3 * HOUR });
    expect(await calendarApprovalDetails('calendar_update_event', args)).toEqual({});
    fake.state.status = 2;
    expect(await calendarApprovalDetails('calendar_update_event', args)).toEqual({});
    expect(args).toEqual({ calendar: '日历', event_uid: 'missing', start_ms: 3 * HOUR });
    expect(fake.state.grants).toBe(0);
  });

  it('③ undo rebuilds the deleted event from the host-side snapshot once; a second click does not create another', async () => {
    fake.state.items.push({ id: 'cal-id-8012:EV1', calendarId: 'cal-id-8012', calendar: '日历', title: '评审', startMs: HOUR, endMs: 2 * HOUR, location: '三楼', notes: '带材料' });
    const result = await run(calendarDeleteEventModule, { calendar: '日历', event_uid: 'cal-id-8012:EV1' });
    // Storage shape seen in the Dev DB: the call lives on the assistant message, the result on a separate role=tool message.
    store.messages.push(
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'tc-del', name: 'calendar_delete_event', arguments: {} }] } as Message,
      { id: 'm2', role: 'tool', content: '', timestamp: 2, toolResults: [{ toolCallId: 'tc-del', success: true, output: result.output, metadata: result.meta }] } as Message,
    );
    expect(fake.state.items).toEqual([]);

    const first = await undoCalendarDelete('s', 'tc-del');
    expect(first).toMatchObject({ ok: true });
    expect(fake.state.items).toHaveLength(1);
    expect(fake.state.calls.at(-1)?.body).toMatchObject({ op: 'create', title: '评审', startMs: HOUR, endMs: 2 * HOUR, location: '三楼', notes: '带材料', calendarId: 'cal-id-8012' });
    expect(store.updates[0]).toMatchObject({ id: 'm2' });
    expect(store.updates[0].updates.toolResults?.[0].metadata).toMatchObject({ undoneUid: expect.any(String) });

    expect(await undoCalendarDelete('s', 'tc-del')).toEqual({ ok: false, reason: 'already_undone' });
    expect(fake.state.items).toHaveLength(1);
    expect(await undoCalendarDelete('s', 'unknown')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('④ a meeting invite with very long notes still restores (notes capped under the bridge body limit, marked as truncated)', async () => {
    const longNotes = '拨入号码与多语言说明。'.repeat(3_000); // 30k chars ≈ 90 KB UTF-8, over the 64 KiB bridge limit
    fake.state.items.push({ id: 'cal-id-8012:EV2', calendarId: 'cal-id-8012', calendar: '日历', title: '周会', startMs: HOUR, endMs: 2 * HOUR, notes: longNotes });
    const result = await run(calendarDeleteEventModule, { calendar: '日历', event_uid: 'cal-id-8012:EV2' });
    store.messages.push(
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'tc-long', name: 'calendar_delete_event', arguments: {} }] } as Message,
      { id: 'm2', role: 'tool', content: '', timestamp: 2, toolResults: [{ toolCallId: 'tc-long', success: true, output: result.output, metadata: result.meta }] } as Message,
    );
    expect(await undoCalendarDelete('s', 'tc-long')).toMatchObject({ ok: true });
    const body = fake.state.calls.at(-1)?.body as { notes: string };
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThan(64 * 1024);
    expect(body.notes.endsWith('（备注过长，撤销时已截断）')).toBe(true);
    expect(body.notes.startsWith('拨入号码与多语言说明。')).toBe(true);
  });

  it('⑤ the cut never splits an emoji (a lone surrogate would make the native JSON parser reject the restore)', async () => {
    const notes = `${'a'.repeat(15_999)}😀${'b'.repeat(100)}`; // the emoji straddles the 16000-unit cut
    fake.state.items.push({ id: 'cal-id-8012:EV3', calendarId: 'cal-id-8012', calendar: '日历', title: '表情', startMs: HOUR, endMs: 2 * HOUR, notes });
    const result = await run(calendarDeleteEventModule, { calendar: '日历', event_uid: 'cal-id-8012:EV3' });
    store.messages.push(
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'tc-emoji', name: 'calendar_delete_event', arguments: {} }] } as Message,
      { id: 'm2', role: 'tool', content: '', timestamp: 2, toolResults: [{ toolCallId: 'tc-emoji', success: true, output: result.output, metadata: result.meta }] } as Message,
    );
    expect(await undoCalendarDelete('s', 'tc-emoji')).toMatchObject({ ok: true });
    const restored = (fake.state.calls.at(-1)?.body as { notes: string }).notes;
    expect(restored.isWellFormed()).toBe(true);
  });

  it('⑥ notes full of control characters (6-byte JSON escapes) still fit the bridge body limit', async () => {
    const notes = '\u0001'.repeat(15_000);
    fake.state.items.push({ id: 'cal-id-8012:EV4', calendarId: 'cal-id-8012', calendar: '日历', title: '控制字符', startMs: HOUR, endMs: 2 * HOUR, notes });
    const result = await run(calendarDeleteEventModule, { calendar: '日历', event_uid: 'cal-id-8012:EV4' });
    store.messages.push(
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'tc-ctl', name: 'calendar_delete_event', arguments: {} }] } as Message,
      { id: 'm2', role: 'tool', content: '', timestamp: 2, toolResults: [{ toolCallId: 'tc-ctl', success: true, output: result.output, metadata: result.meta }] } as Message,
    );
    expect(await undoCalendarDelete('s', 'tc-ctl')).toMatchObject({ ok: true });
    expect(Buffer.byteLength(JSON.stringify(fake.state.calls.at(-1)?.body), 'utf8')).toBeLessThan(64 * 1024);
  });
});
