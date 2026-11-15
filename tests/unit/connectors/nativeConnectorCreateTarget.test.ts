import { beforeEach, describe, expect, it, vi } from 'vitest';

const osascriptMocks = vi.hoisted(() => ({
  runAppleScript: vi.fn(),
}));

vi.mock('../../../src/host/connectors/native/osascript', () => ({
  runAppleScript: osascriptMocks.runAppleScript,
  escapeAppleScriptString: (value: string) => value,
  parseAppleScriptDate: () => null,
  buildAppleScriptDateVar: () => [],
  sharedAppleScriptHandlers: () => [],
}));

import { remindersConnector } from '../../../src/host/connectors/native/reminders';

beforeEach(() => {
  osascriptMocks.runAppleScript.mockReset();
});

function scriptAt(index: number): string {
  return (osascriptMocks.runAppleScript.mock.calls[index]?.[0] as string[]).join('\n');
}

describe('native connector create target resolution', () => {
  describe('Reminders', () => {
    it('uses the default list when omitted and returns its real name', async () => {
      osascriptMocks.runAppleScript.mockResolvedValueOnce('r-default|提醒事项|Default reminder|false');

      const result = await remindersConnector.execute('create_reminder', { title: 'Default reminder' });

      expect(result.data).toMatchObject({ id: 'r-default', list: '提醒事项', title: 'Default reminder' });
      expect(scriptAt(0)).toContain('set targetList to default list');
      expect(scriptAt(0)).toContain('name of targetList');
      expect(scriptAt(0)).not.toContain('tell list "');
    });

    it('rejects a nonexistent list with all options before running a write script', async () => {
      osascriptMocks.runAppleScript.mockResolvedValueOnce('Work\n提醒事项\nPersonal');

      await expect(remindersConnector.execute('create_reminder', {
        list: 'Missing',
        title: 'Should not be created',
      })).rejects.toThrow(
        'No reminder list named "Missing". Available lists: Work, 提醒事项, Personal. Omit list to use the default list.',
      );
      expect(osascriptMocks.runAppleScript).toHaveBeenCalledTimes(1);
    });

    it('accepts a localized list name and writes with the exact real name', async () => {
      osascriptMocks.runAppleScript
        .mockResolvedValueOnce('Work\n提醒事项')
        .mockResolvedValueOnce('r-localized|提醒事项|Localized reminder|false');

      const result = await remindersConnector.execute('create_reminder', {
        list: '提醒事项',
        title: 'Localized reminder',
      });

      expect(result.data).toMatchObject({ list: '提醒事项' });
      expect(scriptAt(1)).toContain('tell list "提醒事项"');
    });

    it('resolves a wrong-case list name to the real name', async () => {
      osascriptMocks.runAppleScript
        .mockResolvedValueOnce('Work\nPersonal')
        .mockResolvedValueOnce('r-case|Work|Case reminder|false');

      const result = await remindersConnector.execute('create_reminder', {
        list: 'work',
        title: 'Case reminder',
      });

      expect(result.data).toMatchObject({ list: 'Work' });
      expect(scriptAt(1)).toContain('tell list "Work"');
    });
  });
  // Calendar 的建日程目标解析改走 EventKit，见 calendarEventKit.test.ts
});
