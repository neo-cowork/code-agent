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

import { calendarConnector } from '../../../src/host/connectors/native/calendar';
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

  describe('Calendar', () => {
    it('uses the first writable calendar when omitted and returns its real name', async () => {
      osascriptMocks.runAppleScript
        .mockResolvedValueOnce('日历')
        .mockResolvedValueOnce('evt-default|日历|Default event|||');

      const result = await calendarConnector.execute('create_event', {
        title: 'Default event',
        start_ms: 1_700_000_000_000,
      });

      expect(result.data).toMatchObject({ calendar: '日历', title: 'Default event' });
      expect(scriptAt(0)).toContain('if writable of cal then');
      expect(scriptAt(1)).toContain('tell calendar "日历"');
    });

    it('reports a plain-words error when no writable calendar exists', async () => {
      osascriptMocks.runAppleScript.mockResolvedValueOnce('');

      await expect(calendarConnector.execute('create_event', {
        title: 'Should not be created',
        start_ms: 1_700_000_000_000,
      })).rejects.toThrow(
        'No writable calendar is available. Omit calendar to use the first writable calendar.',
      );
      expect(osascriptMocks.runAppleScript).toHaveBeenCalledTimes(1);
    });

    it('rejects a nonexistent calendar with all options before running a write script', async () => {
      osascriptMocks.runAppleScript.mockResolvedValueOnce('日历\nWork\nPersonal');

      await expect(calendarConnector.execute('create_event', {
        calendar: 'Missing',
        title: 'Should not be created',
        start_ms: 1_700_000_000_000,
      })).rejects.toThrow(
        'No calendar named "Missing". Available calendars: 日历, Work, Personal. Omit calendar to use the first writable calendar.',
      );
      expect(osascriptMocks.runAppleScript).toHaveBeenCalledTimes(1);
    });

    it('accepts a localized calendar name and writes with the exact real name', async () => {
      osascriptMocks.runAppleScript
        .mockResolvedValueOnce('Work\n日历')
        .mockResolvedValueOnce('evt-localized|日历|Localized event|||');

      const result = await calendarConnector.execute('create_event', {
        calendar: '日历',
        title: 'Localized event',
        start_ms: 1_700_000_000_000,
      });

      expect(result.data).toMatchObject({ calendar: '日历' });
      expect(scriptAt(1)).toContain('tell calendar "日历"');
    });

    it('resolves a wrong-case calendar name to the real name', async () => {
      osascriptMocks.runAppleScript
        .mockResolvedValueOnce('Work\nPersonal')
        .mockResolvedValueOnce('evt-case|Work|Case event|||');

      const result = await calendarConnector.execute('create_event', {
        calendar: 'work',
        title: 'Case event',
        start_ms: 1_700_000_000_000,
      });

      expect(result.data).toMatchObject({ calendar: 'Work' });
      expect(scriptAt(1)).toContain('tell calendar "Work"');
    });
  });
});
