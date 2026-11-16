import { beforeEach, describe, expect, it, vi } from 'vitest';

const osascriptMocks = vi.hoisted(() => ({
  runAppleScript: vi.fn(),
}));

vi.mock('../../../src/host/connectors/native/osascript', () => ({
  runAppleScript: osascriptMocks.runAppleScript,
  escapeAppleScriptString: (value: string) => value,
  parseAppleScriptDate: (value: string) => {
    if (value === 'START') return 1_000;
    if (value === 'END') return 2_000;
    if (value === 'REMIND') return 3_000;
    return null;
  },
  buildAppleScriptDateVar: () => [],
  sharedAppleScriptHandlers: () => [],
}));

import { remindersConnector } from '../../../src/host/connectors/native/reminders';

beforeEach(() => {
  osascriptMocks.runAppleScript.mockReset();
});

describe('native connector exact object lookup', () => {
  // 日历按 uid 取单条改走 EventKit，见 calendarEventKit.test.ts
  it('gets one reminder by id regardless of completion state or list limit', async () => {
    osascriptMocks.runAppleScript.mockResolvedValue(
      'r1|Work|Original title|true|Original notes|REMIND',
    );

    const result = await remindersConnector.execute('get_reminder', {
      list: 'Work',
      reminder_id: 'r1',
    });

    expect(result.data).toEqual({
      id: 'r1',
      list: 'Work',
      title: 'Original title',
      completed: true,
      notes: 'Original notes',
      remindAtMs: 3_000,
    });
    const scriptLines = osascriptMocks.runAppleScript.mock.calls[0]?.[0] as string[];
    expect(scriptLines).toContain('set targetReminder to first reminder whose id is "r1"');
    expect(scriptLines.join('\n')).toContain('my sanitizeText("Work")');
    expect(scriptLines.join('\n')).not.toContain('name of list of targetReminder');
    expect(scriptLines.join('\n')).not.toContain('completed is false');
    expect(scriptLines.join('\n')).not.toContain('reminderLimit');
  });

  it('returns create handles using the known container names', async () => {
    osascriptMocks.runAppleScript.mockResolvedValueOnce(
      'Work',
    );
    osascriptMocks.runAppleScript.mockResolvedValueOnce(
      'r-created|Work|Created reminder|false',
    );
    const reminderResult = await remindersConnector.execute('create_reminder', {
      list: 'Work',
      title: 'Created reminder',
    });
    expect(reminderResult.data).toMatchObject({ id: 'r-created', list: 'Work' });
    const reminderScript = osascriptMocks.runAppleScript.mock.calls[1]?.[0] as string[];
    expect(reminderScript.join('\n')).toContain('my sanitizeText("Work")');
    expect(reminderScript.join('\n')).not.toContain('name of list of newReminder');
  });
});
