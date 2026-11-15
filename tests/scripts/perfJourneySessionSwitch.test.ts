import { describe, expect, it } from 'vitest';
import { journeyRule, runJourneyRatchet, shouldRunJourneyProbe } from '../../scripts/perf/journey-probe-test-support.ts';

describe('perf-journey session-switch slot', () => {
  it('occupies exactly one gates:fast file slot', () => {
    expect(journeyRule('perf-journey-session-switch').files).toEqual([
      'tests/scripts/perfJourneySessionSwitch.test.ts',
    ]);
  });

  it.skipIf(!shouldRunJourneyProbe())('commit count holds the baseline', () => {
    const result = runJourneyRatchet('session-switch');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const countMatch = result.stdout.match(/session-switch commitCount current=(\d+)/);
    expect(countMatch).not.toBeNull();
    const commitCount = Number(countMatch?.[1]);
    const traceMatch = result.stdout.match(/\[perf-journey-ratchet\] session-switch commit-trace: (.+)/);
    expect(traceMatch).not.toBeNull();
    const entries = (traceMatch?.[1] ?? '').split(' | ');
    expect(entries).toHaveLength(commitCount);
    expect(result.stdout).toContain('[perf-journey-ratchet] session-switch environment: viewport=');
  }, 90_000);
});
