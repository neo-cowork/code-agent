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
  // 日历已改走 EventKit（N-CALENDAR-ONE-PERMISSION-EVENTKIT），日历的目标解析见 tests/unit/connectors/calendarEventKit.test.ts
  it('uses the Chinese Reminders default list when list is omitted', async () => {
    const handler = await remindersCreateModule.createHandler();
    const result = await handler.execute(
      { title: '默认提醒' },
      makeContext(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('已创建提醒：\n- [提醒事项] 默认提醒\n提醒时间：无法确认，请在提醒事项中查看');
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

});
