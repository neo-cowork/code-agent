import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  runAppleScript: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../src/host/connectors/native/osascript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/connectors/native/osascript')>();
  return { ...actual, runAppleScript: mocks.runAppleScript };
});

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));

import { mailConnector } from '../../../src/host/connectors/native/mail';
import { calendarConnector } from '../../../src/host/connectors/native/calendar';
import { remindersConnector } from '../../../src/host/connectors/native/reminders';

const EXPECTED = new Date(2026, 10, 3, 22, 15, 30).getTime();
const EXPECTED_NOON = new Date(2026, 10, 3, 12, 15, 30).getTime();
const EXPECTED_AM = new Date(2026, 10, 3, 10, 15, 30).getTime();

const FIXTURES: Array<[string, string, number]> = [
  ['Chinese weekday', '2026年11月3日 星期二 22:15:30', EXPECTED],
  ['Chinese no weekday', '2026年11月3日 22:15:30', EXPECTED],
  ['Chinese 下午', '2026年11月3日 星期二 下午10:15:30', EXPECTED],
  ['Chinese 上午', '2026年11月3日 上午10:15:30', EXPECTED_AM],
  ['Chinese 中午 noon', '2026年11月3日 星期二 中午12:15:30', EXPECTED_NOON],
  ['English 24h', 'Tuesday, November 3, 2026 at 22:15:30', EXPECTED],
  ['English PM', 'Tuesday, November 3, 2026 at 10:15:30 PM', EXPECTED],
  ['English AM', 'Tuesday, November 3, 2026 at 10:15:30 AM', EXPECTED_AM],
  ['ISO', '2026-11-03T22:15:30', EXPECTED],
];

beforeEach(() => {
  mocks.runAppleScript.mockReset();
  mocks.warn.mockReset();
});

describe.each(FIXTURES)('%s (%s)', (_name, raw, expected) => {
  it('mail list_messages / read_message', async () => {
    mocks.runAppleScript.mockResolvedValueOnce(`7|Hi|a@x.com|${raw}|true`);
    const list = await mailConnector.execute('list_messages', { mailbox: 'INBOX' });
    expect((list.data as Array<{ receivedAtMs: number | null }>)[0].receivedAtMs).toBe(expected);

    mocks.runAppleScript.mockResolvedValueOnce(`7|Hi|a@x.com|${raw}|true|body|0|`);
    const read = await mailConnector.execute('read_message', { mailbox: 'INBOX', message_id: 7 });
    expect((read.data as { receivedAtMs: number | null }).receivedAtMs).toBe(expected);
  });

  it('calendar list / get / create / update', async () => {
    const line = `u1|Work|Meet|${raw}|${raw}|Room|n|`;
    mocks.runAppleScript
      .mockResolvedValueOnce('Work')
      .mockResolvedValueOnce(line);
    const list = await calendarConnector.execute('list_events', {
      from_ms: EXPECTED - 86_400_000, to_ms: EXPECTED + 86_400_000,
    });
    const ev = (list.data as Array<{ startAtMs: number | null; endAtMs: number | null }>)[0];
    expect([ev.startAtMs, ev.endAtMs]).toEqual([expected, expected]);

    mocks.runAppleScript.mockResolvedValueOnce(line);
    const got = (await calendarConnector.execute('get_event', { calendar: 'Work', event_uid: 'u1' })).data as typeof ev;
    expect([got.startAtMs, got.endAtMs]).toEqual([expected, expected]);

    mocks.runAppleScript
      .mockResolvedValueOnce('Work')
      .mockResolvedValueOnce(`u1|Work|Meet|${raw}|${raw}|Room`);
    const created = (await calendarConnector.execute('create_event', {
      calendar: 'Work', title: 'Meet', start_ms: EXPECTED,
    })).data as typeof ev;
    expect([created.startAtMs, created.endAtMs]).toEqual([expected, expected]);

    mocks.runAppleScript.mockResolvedValueOnce(`u1|Work|Meet|${raw}|${raw}|Room`);
    const updated = (await calendarConnector.execute('update_event', {
      calendar: 'Work', event_uid: 'u1', title: 'Meet',
    })).data as typeof ev;
    expect([updated.startAtMs, updated.endAtMs]).toEqual([expected, expected]);
  });

  it('reminders list / get', async () => {
    mocks.runAppleScript.mockResolvedValueOnce(`r1|Home|Buy|false|note|${raw}`);
    const list = await remindersConnector.execute('list_reminders', {});
    expect((list.data as Array<{ remindAtMs: number | null }>)[0].remindAtMs).toBe(expected);

    mocks.runAppleScript.mockResolvedValueOnce(`r1|Home|Buy|false|note|${raw}`);
    const got = await remindersConnector.execute('get_reminder', { list: 'Home', reminder_id: 'r1' });
    expect((got.data as { remindAtMs: number | null }).remindAtMs).toBe(expected);
  });
});

describe('degenerate dates', () => {
  it('empty string stays null without warning', async () => {
    mocks.runAppleScript.mockResolvedValueOnce('r1|Home|Buy|false|note|');
    const list = await remindersConnector.execute('list_reminders', {});
    expect((list.data as Array<{ remindAtMs: number | null }>)[0].remindAtMs).toBeNull();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('unparseable non-empty string warns with the raw text and returns null', async () => {
    const raw = '3 novembre 2026 à 22:15:30';
    mocks.runAppleScript.mockResolvedValueOnce(`7|Hi|a@x.com|${raw}|true`);
    const list = await mailConnector.execute('list_messages', { mailbox: 'INBOX' });
    expect((list.data as Array<{ receivedAtMs: number | null }>)[0].receivedAtMs).toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.warn.mock.calls[0])).toContain(raw);
  });
});

describe('locale-independent fetch scripts', () => {
  it('scripts use isoDateText with the shared handler instead of "as text" dates', async () => {
    const scripts: string[] = [];
    mocks.runAppleScript.mockImplementation(async (lines: string[]) => {
      const script = lines.join('\n');
      scripts.push(script);
      if (script.includes('repeat with cal in every calendar')) return 'W';
      if (script.includes('set newEvent to make new event')) return 'u1|W|t|2026-11-03T22:15:30|2026-11-03T22:15:30|';
      return '';
    });
    await mailConnector.execute('list_messages', { mailbox: 'INBOX' });
    await mailConnector.execute('read_message', { mailbox: 'INBOX', message_id: 1 }).catch(() => undefined);
    await calendarConnector.execute('list_events', { calendar: 'W' });
    await calendarConnector.execute('get_event', { calendar: 'W', event_uid: 'u' }).catch(() => undefined);
    await calendarConnector.execute('create_event', { calendar: 'W', title: 't', start_ms: 1 }).catch(() => undefined);
    await calendarConnector.execute('update_event', { calendar: 'W', event_uid: 'u', title: 't' }).catch(() => undefined);
    await remindersConnector.execute('list_reminders', {});
    await remindersConnector.execute('get_reminder', { list: 'L', reminder_id: 'r' }).catch(() => undefined);
    expect(scripts).toHaveLength(9);
    const dateScripts = scripts.filter((script) => !script.includes('repeat with cal in every calendar'));
    const createWriteScript = scripts.find((script) => script.includes('set newEvent to make new event'));
    expect(createWriteScript).toBeDefined();
    expect(createWriteScript).toContain('my isoDateText(start date of newEvent)');
    for (const script of dateScripts) {
      expect(script).toContain('on isoDateText(d)');
      expect(script).toMatch(/my isoDateText\(/);
      expect(script).not.toMatch(/(date received|start date|end date)[^)]*\) as text/);
      expect(script).not.toMatch(/sanitizeText\(rawRemindDate\)/);
    }
  });
});

describe('reminder creation read-back', () => {
  it('keeps an omitted read-back time unknown instead of throwing or inventing the requested time', async () => {
    mocks.runAppleScript.mockResolvedValueOnce('r-created|提醒事项|Report|false');
    const result = await remindersConnector.execute('create_reminder', {
      title: 'Report', remind_at_ms: 1_800_000_000_000,
    });
    expect(result.data).toMatchObject({ id: 'r-created', remindAtMs: undefined });
  });

  it('reads the stored remind-me date in the create transaction and parses it', async () => {
    mocks.runAppleScript.mockResolvedValueOnce('r-created|提醒事项|Report|false|2026-11-09T09:00:00');
    const result = await remindersConnector.execute('create_reminder', {
      title: 'Report', remind_at_ms: new Date(2026, 10, 9, 9).getTime(),
    });
    expect(result.data).toMatchObject({ remindAtMs: new Date(2026, 10, 9, 9).getTime() });
    const script = mocks.runAppleScript.mock.calls[0][0].join('\n');
    expect(script).toContain('set rawRemindDate to remind me date of newReminder');
    expect(script).toContain('my isoDateText(rawRemindDate)');
    expect(script).toContain('set remind me date of newReminder to remindDate');
  });

  it('reads an actual missing date as null', async () => {
    mocks.runAppleScript.mockResolvedValueOnce('r-created|提醒事项|Report|false|');
    const result = await remindersConnector.execute('create_reminder', { title: 'Report' });
    expect(result.data).toMatchObject({ remindAtMs: null });
  });
});
