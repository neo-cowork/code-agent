import { describe, expect, it } from 'vitest';
import { journeyRule, runJourneyRatchet, shouldRunJourneyProbe } from '../../scripts/perf/journey-probe-test-support.ts';

describe('perf-journey cold-start slot', () => {
  it('occupies exactly one gates:fast file slot', () => {
    expect(journeyRule('perf-journey-cold-start').files).toEqual([
      'tests/scripts/perfJourneyColdStart.test.ts',
    ]);
  });

  it.skipIf(!shouldRunJourneyProbe())('commit count holds the baseline', () => {
    const result = runJourneyRatchet('cold-start');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const countMatch = result.stdout.match(/cold-start commitCount current=(\d+)/);
    expect(countMatch).not.toBeNull();
    const commitCount = Number(countMatch?.[1]);
    const traceMatch = result.stdout.match(/\[perf-journey-ratchet\] cold-start commit-trace: (.+)/);
    expect(traceMatch).not.toBeNull();
    const entries = (traceMatch?.[1] ?? '').split(' | ');
    expect(entries).toHaveLength(commitCount);
    expect(entries[0]).toMatch(/^#1 (mount|update|nested-update)@-?\d+\.\dms\/\d+\.\dms$/);
    expect(result.stdout).toContain('[perf-journey-ratchet] cold-start environment: viewport=');
  }, 90_000);
});
