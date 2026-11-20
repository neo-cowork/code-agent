// Don't Allow leaves EventKit's class status at 0. The bridge completion bool is the denial.
import { describe, expect, it, vi } from 'vitest';
import { ENV_ASSIST_CALENDAR_POLL_MS } from '../../../../../src/shared/constants/envAssist';

const { info } = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock('../../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    info: (...args: unknown[]) => info(...args),
  }),
}));

import { askCalendarOnce } from '../../../../../src/host/permissions/envAssist/calendarSetting';
import { calendarAccess } from '../../../../../src/host/permissions/envAssist/probes/passiveProbes';
import { createShellPassiveBridge } from '../../../../../src/host/permissions/envAssist/probes/shellPassiveBridge';

interface CalendarBody {
  status: number;
  raw: number;
  answer: boolean | null;
}

function bridge(body: CalendarBody) {
  const client = {
    post: async (path: string) => {
      if (path !== '/v1/passive/calendar') throw new Error(`unexpected ${path}`);
      return body;
    },
  };
  return createShellPassiveBridge(client as never);
}

describe('EKAuthorizationStatusForEvents answer → calendarAccess', () => {
  it('{status:0,raw:0,answer:false} returns denied', async () => {
    const access = await calendarAccess(bridge({ status: 0, raw: 0, answer: false }));
    expect(access).toBe('denied');
    process.stdout.write(`① {status:0,raw:0,answer:false} -> ${access}\n`);
  });

  it('{status:0,raw:0,answer:null} still undecided', async () => {
    const access = await calendarAccess(bridge({ status: 0, raw: 0, answer: null }));
    expect(access).toBe('undecided');
    process.stdout.write(`① {status:0,raw:0,answer:null} -> ${access}\n`);
  });

  it('{status:0,raw:0,answer:true} leaves the granted path unchanged', async () => {
    const stale = await calendarAccess(bridge({ status: 0, raw: 0, answer: true }));
    const granted = await calendarAccess(bridge({ status: 3, raw: 0, answer: true }));
    expect(stale).toBe('undecided');
    expect(granted).toBe('granted');
    process.stdout.write(`① {status:0,raw:0,answer:true} -> ${stale}; {status:3,raw:0,answer:true} -> ${granted}\n`);
  });
});

describe('askCalendarOnce over createShellPassiveBridge', () => {
  it('resolves denied after the first poll when the completion answer is false', async () => {
    let reads = 0;
    const client = {
      post: async (path: string) => {
        if (path !== '/v1/passive/calendar') throw new Error(`unexpected ${path}`);
        reads += 1;
        return reads === 1
          ? { status: 0, raw: 0, answer: null }
          : { status: 0, raw: 0, answer: false };
      },
    };
    const sleeps: number[] = [];
    let now = 0;
    const result = await askCalendarOnce({
      access: () => calendarAccess(createShellPassiveBridge(client as never)),
      prompt: async () => 'requested',
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
      now: () => now,
    });
    expect(result).toEqual({ access: 'denied', prompted: true });
    expect(sleeps).toEqual([ENV_ASSIST_CALENDAR_POLL_MS]);
    const answered = info.mock.calls.find((call) => call[0] === 'Calendar ask: answered');
    expect(answered).toEqual(['Calendar ask: answered', { access: 'denied', polls: 1, waitedMs: ENV_ASSIST_CALENDAR_POLL_MS }]);
    process.stdout.write(`② ${JSON.stringify(answered)} sleeps=${JSON.stringify(sleeps)}\n`);
  });
});
