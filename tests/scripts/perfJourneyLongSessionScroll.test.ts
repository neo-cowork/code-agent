import { describe, expect, it } from 'vitest';
import { journeyRule, runJourneyRatchet, shouldRunJourneyProbe } from '../../scripts/perf/journey-probe-test-support.ts';

describe('perf-journey long-session-scroll slot', () => {
  it('occupies exactly one gates:fast file slot', () => {
    expect(journeyRule('perf-journey-long-session-scroll').files).toEqual([
      'tests/scripts/perfJourneyLongSessionScroll.test.ts',
    ]);
  });

  it.skipIf(!shouldRunJourneyProbe())('commit count holds the baseline', () => {
    const result = runJourneyRatchet('long-session-scroll');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const countMatch = result.stdout.match(/long-session-scroll commitCount current=(\d+)/);
    expect(countMatch).not.toBeNull();
    const commitCount = Number(countMatch?.[1]);
    const traceMatch = result.stdout.match(/\[perf-journey-ratchet\] long-session-scroll commit-trace: (.+)/);
    expect(traceMatch).not.toBeNull();
    const entries = (traceMatch?.[1] ?? '').split(' | ');
    expect(entries).toHaveLength(commitCount);
    expect(entries[0]).toMatch(/^#1 (mount|update|nested-update)@-?\d+\.\dms\/\d+\.\dms$/);
    expect(result.stdout).toContain('[perf-journey-ratchet] long-session-scroll environment: viewport=');
  }, 90_000);
});
