import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const mocks = vi.hoisted(() => ({ runAppleScript: vi.fn() }));
vi.mock('../../../src/host/connectors/native/osascript', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/connectors/native/osascript')>(),
  runAppleScript: mocks.runAppleScript,
}));
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'en' } }) }),
}));

import { remindersConnector, resetRemindersConnectorReadiness } from '../../../src/host/connectors/native/reminders';

// Synthetic lines in the existing six-field osascript wire format; no user data.
const OPEN_LINES = [
  'x-apple-reminder://R1|Home|Buy milk|false|Two bottles|2026-11-09T09:30:00',
  'x-apple-reminder://R2|Home|Call dentist|false||',
  'x-apple-reminder://R3|Work|Send proposal|false|Review draft|2026-11-10T16:00:00',
  ...Array.from({ length: 6 }, (_, i) => `x-apple-reminder://R${i + 4}|Work|Task ${i + 4}|false||`),
];
const COMPLETED_LINE = 'x-apple-reminder://R10|Home|Water plants|true|Done|2026-11-08T08:00:00';
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  mocks.runAppleScript.mockReset();
  resetRemindersConnectorReadiness();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  resetRemindersConnectorReadiness();
  vi.useRealTimers();
});

function script(): string {
  expect(mocks.runAppleScript).toHaveBeenCalledTimes(1);
  return (mocks.runAppleScript.mock.calls[0][0] as string[]).join('\n');
}

describe('Reminders bulk list read', () => {
  it('bulk reads fields per list and preserves all six parsed fields for nine open reminders', async () => {
    mocks.runAppleScript.mockResolvedValue(OPEN_LINES.join('\n'));
    const result = await remindersConnector.execute('list_reminders', {});
    const source = script();
    const query = '(every reminder of reminderList whose completed is false)';
    expect(source).toContain(`set {reminderIds, reminderNames, reminderCompleted} to {id, name, completed} of ${query}`);
    expect(source).toContain(`set reminderBodies to body of ${query}`);
    expect(source).toContain(`set reminderDates to remind me date of ${query}`);
    expect(source).toContain('set targetLists to every list');
    expect(source).toContain('set reminderLimit to 20');
    expect(source).not.toMatch(/repeat with reminderItem|of reminderItem/);
    const itemLoop = source.split('repeat with reminderIndex from 1 to count of reminderIds')[1]?.split('end repeat')[0];
    expect(itemLoop).toBeDefined();
    expect(itemLoop).not.toMatch(/\b(id|name|body|completed|remind me date) of\b|of reminderList|every reminder/);
    expect(source.indexOf('set reminderListName')).toBeLessThan(source.indexOf('repeat with reminderIndex'));
    expect(source.match(/if emittedCount >= reminderLimit then exit repeat/g)).toHaveLength(2);
    expect(result.data).toEqual([
      { id: 'x-apple-reminder://R1', list: 'Home', title: 'Buy milk', completed: false, notes: 'Two bottles', remindAtMs: new Date(2026, 10, 9, 9, 30).getTime() },
      { id: 'x-apple-reminder://R2', list: 'Home', title: 'Call dentist', completed: false, notes: undefined, remindAtMs: null },
      { id: 'x-apple-reminder://R3', list: 'Work', title: 'Send proposal', completed: false, notes: 'Review draft', remindAtMs: new Date(2026, 10, 10, 16).getTime() },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `x-apple-reminder://R${i + 4}`, list: 'Work', title: `Task ${i + 4}`, completed: false, notes: undefined, remindAtMs: null })),
    ]);
  });

  it('includes completed items only when requested and trims/escapes the list name', async () => {
    mocks.runAppleScript.mockResolvedValue(`${OPEN_LINES[0]}\n${COMPLETED_LINE}`);
    const result = await remindersConnector.execute('list_reminders', { list: '  Home "shared"  ', include_completed: true });
    expect(script()).toContain('set targetLists to {list "Home \\"shared\\""}');
    expect(script()).toContain('{id, name, completed} of (every reminder of reminderList)');
    expect(script()).not.toContain('whose completed is false');
    expect(result.data).toHaveLength(2);
    expect((result.data as unknown[])[1]).toEqual({
      id: 'x-apple-reminder://R10', list: 'Home', title: 'Water plants', completed: true,
      notes: 'Done', remindAtMs: new Date(2026, 10, 8, 8).getTime(),
    });
  });

  it.each([[undefined, 20], [0, 1], [-4, 1], [1, 1], [200, 200], [999, 200], ['10', 20]])(
    'preserves the limit clamp for %s (applied across lists)', async (limit, expected) => {
      mocks.runAppleScript.mockResolvedValue(OPEN_LINES[0]);
      const result = await remindersConnector.execute('list_reminders', { limit, include_completed: 'true', list: '  ' });
      expect(script()).toContain(`set reminderLimit to ${expected}`);
      expect(script()).toContain('set emittedCount to 0');
      expect(script()).toContain('set emittedCount to emittedCount + 1');
      expect(script()).toContain('set targetLists to every list');
      expect(script()).toContain('whose completed is false');
      expect(result.data).toHaveLength(1);
    },
  );

  it('keeps an empty result empty', async () => {
    mocks.runAppleScript.mockResolvedValue('\n');
    expect((await remindersConnector.execute('list_reminders', {})).data).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('compiles both generated filter variants with the real AppleScript compiler', async () => {
    for (const include_completed of [false, true]) {
      mocks.runAppleScript.mockClear().mockResolvedValue('');
      await remindersConnector.execute('list_reminders', { include_completed });
      await expect(promisify(execFile)('osacompile', ['-o', '/dev/null', '-e', script()])).resolves.toBeDefined();
    }
  });
});

const READS = [
  ['list_lists', {}, 'Home'],
  ['list_reminders', {}, OPEN_LINES[0]],
  ['get_reminder', { list: 'Home', reminder_id: 'x-apple-reminder://R1' }, OPEN_LINES[0]],
] as const;

describe('Reminders read readiness', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    resetRemindersConnectorReadiness();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
  });

  it.each(READS)('%s clears a prior probe error and reports connected/ready through getStatus', async (action, payload, output) => {
    mocks.runAppleScript.mockRejectedValueOnce(new Error('probe failed'));
    await expect(remindersConnector.execute('probe_access', {})).rejects.toThrow('probe failed');
    expect((await remindersConnector.getStatus()).readiness).toBe('failed');
    vi.setSystemTime(new Date('2026-11-09T12:01:00Z'));
    mocks.runAppleScript.mockResolvedValueOnce(output);
    await remindersConnector.execute(action, payload);
    expect(await remindersConnector.getStatus()).toMatchObject({ connected: true, readiness: 'ready', checkedAt: Date.now(), noAccessibleItems: false });
    expect((await remindersConnector.getStatus()).error).toBeUndefined();
  });

  it.each(READS)('%s failure preserves unchecked, failed and ready status', async (action, payload) => {
    for (const state of ['unchecked', 'failed', 'ready']) {
      resetRemindersConnectorReadiness();
      if (state === 'failed') {
        mocks.runAppleScript.mockRejectedValueOnce(new Error('probe failed'));
        await remindersConnector.execute('probe_access', {}).catch(() => undefined);
      } else if (state === 'ready') {
        mocks.runAppleScript.mockResolvedValueOnce('Home');
        await remindersConnector.execute('list_lists', {});
      }
      const before = await remindersConnector.getStatus();
      vi.advanceTimersByTime(1000);
      mocks.runAppleScript.mockRejectedValueOnce(new Error('read failed'));
      await expect(remindersConnector.execute(action, payload)).rejects.toThrow('read failed');
      expect(await remindersConnector.getStatus()).toEqual(before);
    }
  });

  it('only list_lists emptiness means no accessible lists; an empty filtered reminder read does not', async () => {
    mocks.runAppleScript.mockResolvedValue('');
    await remindersConnector.execute('list_lists', {});
    expect(await remindersConnector.getStatus()).toMatchObject({ connected: true, readiness: 'ready', noAccessibleItems: true });
    await remindersConnector.execute('list_reminders', {});
    expect(await remindersConnector.getStatus()).toMatchObject({ connected: true, readiness: 'ready', noAccessibleItems: false });
  });

  it.each([
    ['create_reminder', { title: 'Test' }, 'r1|Home|Test|false'],
    ['update_reminder', { list: 'Home', reminder_id: 'r1', title: 'Updated' }, 'r1|Home|Updated|false'],
    ['delete_reminder', { list: 'Home', reminder_id: 'r1' }, 'Test'],
  ] as const)('%s does not mark ready', async (action, payload, output) => {
    const before = await remindersConnector.getStatus();
    mocks.runAppleScript.mockResolvedValue(output);
    await remindersConnector.execute(action, payload);
    expect(await remindersConnector.getStatus()).toEqual(before);
  });
});
