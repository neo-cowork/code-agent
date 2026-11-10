import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../src/host/protocol/tools';

const fakeMac = vi.hoisted(() => {
  const scripts: string[] = [];
  const runAppleScript = vi.fn(async (lines: string[]): Promise<string> => {
    const script = lines.join('\n');
    scripts.push(script);

    if (script.includes('tell application "Reminders"')) {
      if (script.includes('repeat with reminderList in every list')) {
        return '提醒事项\n工作';
      }
      if (script.includes('make new reminder')) {
        const list = script.match(/tell list "([^"]+)"/)?.[1] ?? '提醒事项';
        const title = script.match(/name:"([^"]*)"/)?.[1] ?? '';
        return `reminder-1|${list}|${title}|false`;
      }
    }

    if (script.includes('tell application "Calendar"')) {
      if (script.includes('set newEvent to make new event')) {
        const calendar = script.match(/tell calendar "([^"]+)"/)?.[1] ?? '';
        const title = script.match(/summary:"([^"]*)"/)?.[1] ?? '';
        return `event-1|${calendar}|${title}|||`;
      }
      if (script.includes('if writable of cal then')) {
        return '日历\n工作';
      }
      if (script.includes('repeat with cal in every calendar')) {
        return '节假日\n生日\n日历\n工作';
      }
    }

    throw new Error(`Unexpected fake AppleScript: ${script}`);
  });

  return { scripts, runAppleScript };
});

vi.mock('../../../src/host/connectors/native/osascript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/connectors/native/osascript')>();
  return { ...actual, runAppleScript: fakeMac.runAppleScript };
});

vi.mock('../../../src/host/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/connectors')>();
  const registry = new actual.ConnectorRegistry('darwin');
  registry.configure(['reminders', 'calendar']);
  return { ...actual, getConnectorRegistry: () => registry };
});

import { getConnectorRegistry } from '../../../src/host/connectors';
import { calendarCreateEventModule } from '../../../src/host/tools/modules/connectors/calendarCreateEvent';
import { remindersCreateModule } from '../../../src/host/tools/modules/connectors/remindersCreate';

const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeContext(): ToolContext {
  return {
    sessionId: 'localized-targets-test',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => undefined,
  } as ToolContext;
}

function scriptAt(index: number): string {
  return fakeMac.scripts[index] ?? '';
}

function hasCreateScript(): boolean {
  return fakeMac.scripts.some((script) =>
    script.includes('make new reminder') || script.includes('set newEvent to make new event'));
}

beforeEach(() => {
  fakeMac.scripts.length = 0;
  getConnectorRegistry().configure(['reminders', 'calendar']);
});

describe('localized native connector targets through production tools', () => {
  it('uses the Chinese Reminders default list when list is omitted', async () => {
    const handler = await remindersCreateModule.createHandler();
    const result = await handler.execute(
      { title: '默认提醒' },
      makeContext(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('已创建提醒：\n- [提醒事项] 默认提醒');
      expect(result.meta).toMatchObject({ list: '提醒事项' });
      expect(result.output).not.toContain('reminder-1');
    }
    expect(fakeMac.scripts).toHaveLength(1);
    expect(scriptAt(0)).toContain('set targetList to default list');
    expect(scriptAt(0)).toContain('tell targetList');
    console.info('[proof ①] receipt:', result.ok ? result.output : result.error);
    console.info('[proof ①] meta.list:', result.ok ? result.meta?.list : undefined);
    console.info('[proof ①] recorded script lines:', scriptAt(0).split('\n').filter((line) =>
      line.includes('set targetList to default list') || line.includes('tell targetList')).join('\n'));
  });

  it('uses the first writable Chinese calendar when calendar is omitted', async () => {
    const handler = await calendarCreateEventModule.createHandler();
    const result = await handler.execute(
      { title: '默认事件', start_ms: 1_700_000_000_000 },
      makeContext(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('- [日历] 默认事件');
      expect(result.meta).toMatchObject({ calendar: '日历' });
      expect(result.output).not.toContain('event-1');
    }
    expect(fakeMac.scripts).toHaveLength(2);
    expect(scriptAt(0)).toContain('if writable of cal then');
    expect(scriptAt(0)).toContain('repeat with cal in every calendar');
    expect(scriptAt(1)).toContain('tell calendar "日历"');
    expect(hasCreateScript()).toBe(true);
    console.info('[proof ②] receipt:', result.ok ? result.output : result.error);
    console.info('[proof ②] meta.calendar:', result.ok ? result.meta?.calendar : undefined);
    console.info('[proof ②] recorded list script line:', scriptAt(0).split('\n').find((line) =>
      line.includes('if writable of cal then')));
    console.info('[proof ②] recorded create script line:', scriptAt(1).split('\n').find((line) =>
      line.includes('tell calendar "日历"')));
  });

  it('reports every Chinese Reminders list and performs no write for a missing name', async () => {
    const handler = await remindersCreateModule.createHandler();
    const result = await handler.execute(
      { list: '家庭采购', title: '不应创建' },
      makeContext(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        'Reminders create failed: No reminder list named "家庭采购". Available lists: 提醒事项, 工作. Omit list to use the default list.',
      );
    }
    expect(fakeMac.scripts).toHaveLength(1);
    expect(scriptAt(0)).toContain('repeat with reminderList in every list');
    expect(hasCreateScript()).toBe(false);
    console.info('[proof ③ reminders] error:', result.ok ? result.output : result.error);
    console.info('[proof ③ reminders] script count:', fakeMac.scripts.length);
  });

  it('reports every Chinese calendar, including read-only ones, and performs no write for a missing name', async () => {
    const handler = await calendarCreateEventModule.createHandler();
    const result = await handler.execute(
      { calendar: '家庭采购', title: '不应创建', start_ms: 1_700_000_000_000 },
      makeContext(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        'Calendar create failed: No calendar named "家庭采购". Available calendars: 节假日, 生日, 日历, 工作. Omit calendar to use the first writable calendar.',
      );
    }
    expect(fakeMac.scripts).toHaveLength(1);
    expect(scriptAt(0)).toContain('repeat with cal in every calendar');
    expect(scriptAt(0)).not.toContain('if writable of cal then');
    expect(hasCreateScript()).toBe(false);
    console.info('[proof ③ calendar] error:', result.ok ? result.output : result.error);
    console.info('[proof ③ calendar] script count:', fakeMac.scripts.length);
  });
});
