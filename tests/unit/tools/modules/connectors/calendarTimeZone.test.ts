import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { getConnectorRegistry, type Connector } from '../../../../../src/host/connectors';
import { calendarModule } from '../../../../../src/host/tools/modules/connectors/calendar';

vi.hoisted(() => {
  process.env.TZ = 'America/Los_Angeles';
});

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(): ToolContext {
  return {
    sessionId: 'calendar-time-zone-test',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  } as unknown as ToolContext;
}

function makeConnector(execute: Connector['execute']): Connector {
  return {
    id: 'calendar',
    label: 'Calendar',
    capabilities: ['list_events'],
    getStatus: async () => ({ connected: true, readiness: 'ready', capabilities: ['list_events'] }),
    execute,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const registry = getConnectorRegistry();

async function runCalendar() {
  const handler = await calendarModule.createHandler();
  return handler.execute({ action: 'list_events' }, makeCtx(), allowAll);
}

afterEach(() => {
  registry.unregister('calendar');
});

describe('calendar connector time output', () => {
  it('uses the production calendar handler with a now line and explicit local offsets', async () => {
    const execute = vi.fn().mockResolvedValue({
      data: [
        {
          calendar: 'Work',
          title: 'Shanghai morning',
          startAtMs: Date.parse('2026-11-09T01:00:00+08:00'),
          endAtMs: Date.parse('2026-11-09T02:00:00+08:00'),
        },
        {
          calendar: 'Work',
          title: 'Midnight crossing',
          startAtMs: Date.parse('2026-11-09T07:30:00Z'),
          endAtMs: Date.parse('2026-11-09T08:30:00Z'),
        },
        {
          calendar: 'Work',
          title: 'DST change',
          startAtMs: Date.parse('2026-03-08T09:30:00Z'),
          endAtMs: Date.parse('2026-03-08T10:30:00Z'),
        },
      ],
    });
    registry.unregister('calendar');
    registry.register(makeConnector(execute));

    const result = await runCalendar();

    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = result.output.split('\n');
      expect(lines[0]).toMatch(
        /^现在：\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC-[78]\)；时区：America\/Los_Angeles。以下时间均按该时区显示。$/,
      );
      expect(result.output).toContain('2026-11-08 09:00 (UTC-8) -> 2026-11-08 10:00 (UTC-8)');
      expect(result.output).toContain('2026-11-08 23:30 (UTC-8) -> 2026-11-09 00:30 (UTC-8)');
      expect(result.output).toContain('2026-03-08 01:30 (UTC-8) -> 2026-03-08 03:30 (UTC-7)');
      if (process.env.PRINT_CONNECTOR_EVIDENCE === '1') console.log(result.output);
    }
    expect(execute).toHaveBeenCalledWith('list_events', { action: 'list_events' });
  });

  it('puts the now line before the empty result too', async () => {
    const execute = vi.fn().mockResolvedValue({ data: [] });
    registry.unregister('calendar');
    registry.register(makeConnector(execute));

    const result = await runCalendar();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.split('\n')[0]).toContain('以下时间均按该时区显示。');
      expect(result.output).toContain('没有找到匹配的日历事件。');
    }
  });
});
