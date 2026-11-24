import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmationGate } from '../../../src/host/agent/confirmationGate';
import { toolBatchLabel } from '../../../src/host/agent/toolExecution/parallelStrategy';
import { getHostUiLocale } from '../../../src/host/config/hostUiLocale';
import { CalendarFailure } from '../../../src/host/connectors/native/calendar';
import type { ToolContext } from '../../../src/host/protocol/tools';
import { calendarCreateEventModule } from '../../../src/host/tools/modules/connectors/calendarCreateEvent';
import { calendarDeleteEventModule } from '../../../src/host/tools/modules/connectors/calendarDeleteEvent';
import { calendarUpdateEventModule } from '../../../src/host/tools/modules/connectors/calendarUpdateEvent';
import { formatConnectorTime } from '../../../src/host/tools/modules/connectors/connectorTime';
import { en } from '../../../src/renderer/i18n/en';
import { cleanToolResultDisplayText } from '../../../src/renderer/utils/toolResultDisplayText';
import type { ToolArtifact } from '../../../src/shared/contract/artifactBlob';
import { toolProgressLabel } from '../../../src/shared/utils/toolProgressLabel';

import { calendarModule } from '../../../src/host/tools/modules/connectors/calendar';
import { mailSendModule } from '../../../src/host/tools/modules/connectors/mailSend';
import { mailDraftModule } from '../../../src/host/tools/modules/connectors/mailDraft';
import { remindersModule } from '../../../src/host/tools/modules/connectors/reminders';
import { remindersCreateModule } from '../../../src/host/tools/modules/connectors/remindersCreate';
import { remindersUpdateModule } from '../../../src/host/tools/modules/connectors/remindersUpdate';
import { remindersDeleteModule } from '../../../src/host/tools/modules/connectors/remindersDelete';

const execute = vi.fn();
vi.mock('../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({
    get: () => ({ execute }),
  }),
}));
vi.mock('../../../src/host/config/hostUiLocale', () => ({ getHostUiLocale: vi.fn() }));

const args = {
  calendar: 'Work',
  title: 'Project Review',
  event_uid: 'opaque-event-42',
  start_ms: 1_700_000_000_000,
  end_ms: 1_700_001_800_000,
  location: 'Meeting Room',
  notes: 'Bring the quarterly report',
};
const event = {
  uid: args.event_uid,
  calendar: args.calendar,
  title: args.title,
  startAtMs: args.start_ms,
  endAtMs: args.end_ms,
  location: args.location,
  notes: args.notes,
};
const ctx: ToolContext = {
  sessionId: 'test-session',
  workingDir: process.cwd(),
  abortSignal: new AbortController().signal,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  emit: vi.fn(),
};

function expectEnglishDisplay(value: unknown): void {
  expect(value).toEqual(expect.any(String));
  expect(value).not.toMatch(/\p{Script=Han}|\buid\b|opaque-event-42|opaque-reminder-42/iu);
}

beforeEach(() => {
  vi.mocked(getHostUiLocale).mockReturnValue('en');
  execute.mockReset().mockResolvedValue({ data: event });
});

describe('host connector copy', () => {
  const approvals = [
    ['mail_send', { to: ['teammate@example.com'], subject: 'Schedule' }, 'Send email: Schedule'],
    ['mail_draft', { to: ['teammate@example.com'] }, 'Create email draft: (no subject)'],
    ['calendar_create_event', args, 'Create calendar event'],
    ['calendar_update_event', args, 'Update calendar event'],
    ['calendar_delete_event', args, 'Delete calendar event'],
    ['reminders_create', { title: 'Follow up', remind_at_ms: args.start_ms }, 'Create reminder'],
    ['reminders_update', { title: 'Follow up', completed: true }, 'Update reminder'],
    ['reminders_delete', { list: 'Work', reminder_id: 'opaque-reminder-42' }, 'Delete reminder'],
  ] as const;

  it.each(approvals)('%s emits English approval and step copy', (tool, params, summary) => {
    const preview = new ConfirmationGate().buildPreview(tool, { ...params });
    expect(preview?.summary).toBe(summary);
    expectEnglishDisplay(preview?.summary);
    expectEnglishDisplay(preview?.diff);
    const locale = getHostUiLocale();
    const progress = toolBatchLabel(tool, 1, false, locale);
    expect(progress).toBe(toolProgressLabel(tool, locale));
    expectEnglishDisplay(progress);
    expect(progress).not.toContain(tool);
  });

  it('uses English for calendar read progress', () => {
    expect(toolBatchLabel('calendar', 1, false, getHostUiLocale())).toBe('Checking Calendar');
  });

  const calendarWrites = [
    [calendarCreateEventModule, 'Calendar event created', 'Could not create calendar event', '已创建日历事件'],
    [calendarUpdateEventModule, 'Calendar event updated', 'Could not update calendar event', '已更新日历事件'],
    [calendarDeleteEventModule, 'Calendar event deleted', 'Could not delete calendar event', '已删除日历事件'],
  ] as const;

  it.each(calendarWrites)('localizes %s receipts while retaining the model identifier', async (tool, heading, failureName) => {
    const handler = await tool.createHandler();
    const result = await handler.execute(args, ctx, async () => ({ allow: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.output).toContain(`${heading}:\n- [Work] Project Review\n- uid: ${event.uid}`);
    expect(result.meta?.uid).toBe(event.uid);
    const artifact = result.meta?.artifact as ToolArtifact | undefined;
    expect(artifact).toMatchObject({ name: expect.stringContaining(heading) });
    expectEnglishDisplay(artifact?.name);
    expectEnglishDisplay(artifact?.preview);

    if (tool === calendarCreateEventModule) {
      const preview = result.meta?.previewItem;
      expect(preview).toMatchObject({
        title: args.title,
        subtitle: args.calendar,
        content: {
          text: expect.stringContaining(`Start: ${formatConnectorTime(event.startAtMs)}`),
          summary: expect.any(String),
        },
      });
      expectEnglishDisplay(JSON.stringify(preview));
    }

    const displayed = cleanToolResultDisplayText(tool.schema.name, result.output, en.rendererHumanPipe.toolDetails);
    expect(displayed).toContain('[Work] Project Review');
    expectEnglishDisplay(displayed);

    // Update and delete capture the pre-write event first.
    if (tool !== calendarCreateEventModule) execute.mockResolvedValueOnce({ data: event });
    execute.mockRejectedValueOnce(new CalendarFailure('unavailable'));
    const failure = await handler.execute(args, ctx, async () => ({ allow: true }));
    expect(failure).toMatchObject({
      ok: false,
      code: 'unavailable',
      error: expect.stringContaining('（日历只能在 macOS'),
      userMessage: 'Calendar is available in the Neo desktop app on macOS.',
    });
    const failureArtifact = failure.meta?.artifact as ToolArtifact | undefined;
    expect(failureArtifact).toMatchObject({ name: `${failureName}: Project Review` });
    expectEnglishDisplay(failureArtifact?.name);
    expectEnglishDisplay(failureArtifact?.preview);
  });

  it.each(calendarWrites)('preserves the exact Chinese model output for %s', async (tool, _heading, _failureName, zhHeading) => {
    vi.mocked(getHostUiLocale).mockReturnValue('zh');
    const handler = await tool.createHandler();
    const result = await handler.execute(args, ctx, async () => ({ allow: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const lines = [`${zhHeading}：`, '- [Work] Project Review', `- uid: ${event.uid}`];
    if (tool !== calendarDeleteEventModule) {
      lines.push(`- 开始：${formatConnectorTime(event.startAtMs)}`, `- 结束：${formatConnectorTime(event.endAtMs)}`, '- 地点：Meeting Room');
    }
    if (tool === calendarCreateEventModule) lines.push('- 备注：Bring the quarterly report');
    expect(result.output).toBe(lines.join('\n'));
    expect(new ConfirmationGate().buildPreview('calendar_create_event', args)?.summary).toBe('创建日历事件');
    expect(toolBatchLabel('calendar_create_event', 1, false, getHostUiLocale())).toBe('正在创建日程');
  });

  it('localizes the fallback for a missing event time', async () => {
    execute.mockResolvedValue({ data: { ...event, startAtMs: null, endAtMs: null } });
    const handler = await calendarCreateEventModule.createHandler();
    const result = await handler.execute(args, ctx, async () => ({ allow: true }));
    expect(result).toMatchObject({ ok: true, output: expect.stringContaining('Start: Unknown\n- End: Unknown') });
  });
});

describe('mail, reminders and Calendar read receipts', () => {
  const mail = {
    subject: 'Project Review',
    to: ['teammate@example.com'],
    cc: [],
    bcc: [],
    attachments: [],
    sent: true,
    saved: true,
  };
  const reminder = {
    id: 'opaque-reminder-42',
    title: 'Project Review',
    list: 'Work',
    completed: false,
    remindAtMs: null,
  };
  const reminderArgs = { title: reminder.title, list: reminder.list, reminder_id: reminder.id };
  const writes = [
    [mailSendModule, mail, mail, 'Email sent', '已发送邮件：Project Review\nTo: teammate@example.com'],
    [mailDraftModule, mail, mail, 'Email draft created', '已创建邮件草稿：Project Review\nTo: teammate@example.com\n状态：已保存到草稿'],
    [remindersCreateModule, reminderArgs, reminder, 'Reminder created', '已创建提醒：\n- [Work] Project Review\n提醒时间：未设置'],
    [remindersUpdateModule, reminderArgs, reminder, 'Reminder updated', '已更新提醒：\n- #opaque-reminder-42 [Work] Project Review'],
    [remindersDeleteModule, reminderArgs, reminder, 'Reminder deleted', '已删除提醒：\n- #opaque-reminder-42 [Work] Project Review'],
  ] as const;

  it.each(writes)('localizes %s and preserves the Chinese model output', async (tool, input, data, english, chinese) => {
    execute.mockResolvedValue({ data });
    const handler = await tool.createHandler();
    const allow = async () => ({ allow: true as const });
    const result = await handler.execute(input, ctx, allow);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.output).toContain(english);
    const shown = cleanToolResultDisplayText(tool.schema.name, result.output, en.rendererHumanPipe.toolDetails);
    expectEnglishDisplay(shown);
    const artifact = result.meta?.artifact as ToolArtifact | undefined;
    expectEnglishDisplay(artifact?.name);
    expectEnglishDisplay(artifact?.preview);
    if (tool === mailDraftModule || tool === remindersCreateModule) {
      expect(result.meta?.previewItem).toBeDefined();
      expectEnglishDisplay(JSON.stringify(result.meta?.previewItem));
    }

    execute.mockImplementation(async (action) => {
      if (action === 'get_reminder') return { data };
      throw new Error('内部诊断 uid: opaque-reminder-42');
    });
    const failure = await handler.execute(input, ctx, allow);
    const failedArtifact = failure.meta?.artifact as ToolArtifact | undefined;
    expect(failure.ok).toBe(false);
    if (failure.ok) throw new Error('Expected a write failure');
    expectEnglishDisplay(failure.userMessage);
    expectEnglishDisplay(failedArtifact?.name);
    expectEnglishDisplay(failedArtifact?.preview);
    expect(failure.error).toContain('内部诊断 uid: opaque-reminder-42');

    vi.mocked(getHostUiLocale).mockReturnValue('zh');
    execute.mockResolvedValue({ data });
    expect(await handler.execute(input, ctx, allow)).toMatchObject({ ok: true, output: chinese });
  });

  const reads = [
    [calendarModule, { action: 'list_calendars' }, ['Work'], 'Available calendars (1)', '可用日历 (1)：\n- Work'],
    [calendarModule, { action: 'list_events', from_ms: args.start_ms, to_ms: args.end_ms }, [event], 'Calendar events (1)', `日历事件 (1)：\n- [Work] Project Review\n  ${formatConnectorTime(event.startAtMs)} -> ${formatConnectorTime(event.endAtMs)} | Meeting Room\n  uid: opaque-event-42`],
    [remindersModule, { action: 'list_lists' }, ['Work'], 'Available reminder lists (1)', '可用提醒列表 (1)：\n- Work'],
    [remindersModule, { action: 'list_reminders' }, [reminder], 'Reminders (1)', '提醒事项 (1)：\n- #opaque-reminder-42 [Work] Project Review | 无提醒时间'],
  ] as const;

  it.each(reads)('localizes %s %j and removes display-only identifiers', async (tool, input, data, english, chinese) => {
    execute.mockResolvedValue({ data });
    const handler = await tool.createHandler();
    const allow = async () => ({ allow: true as const });
    const result = await handler.execute(input, ctx, allow);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.output).toContain(english);
    expect(result.output).not.toMatch(/\p{Script=Han}/u);
    expectEnglishDisplay(cleanToolResultDisplayText(tool.schema.name, result.output, en.rendererHumanPipe.toolDetails));
    const artifact = result.meta?.artifact as ToolArtifact | undefined;
    expectEnglishDisplay(artifact?.name);
    expectEnglishDisplay(artifact?.preview);

    vi.mocked(getHostUiLocale).mockReturnValue('zh');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(args.start_ms);
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const now = `现在：${formatConnectorTime(args.start_ms)}；时区：${zone}。以下时间均按该时区显示。`;
      const expected = 'Work' === data[0] ? chinese : `${now}\n${chinese}`;
      expect(await handler.execute(input, ctx, allow)).toMatchObject({ ok: true, output: expected });
    } finally {
      vi.useRealTimers();
    }
  });
});
