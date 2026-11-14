import { describe, expect, it } from 'vitest';
import { journeyRule, runJourneyRatchet, shouldRunJourneyProbe } from '../../scripts/perf/journey-probe-test-support.ts';

describe('perf-journey first-token slot', () => {
  it('occupies exactly one gates:fast file slot', () => {
    expect(journeyRule('perf-journey-first-token').files).toEqual([
      'tests/scripts/perfJourneyFirstToken.test.ts',
    ]);
  });

  it.skipIf(!shouldRunJourneyProbe())('commit count holds the baseline', () => {
    const result = runJourneyRatchet('first-token');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const countMatch = result.stdout.match(/first-token commitCount current=(\d+)/);
    expect(countMatch).not.toBeNull();
    const commitCount = Number(countMatch?.[1]);
    const traceMatch = result.stdout.match(/\[perf-journey-ratchet\] first-token commit-trace: (.+)/);
    expect(traceMatch).not.toBeNull();
    const entries = (traceMatch?.[1] ?? '').split(' | ');
    expect(entries).toHaveLength(commitCount);
    expect(result.stdout).toContain('[perf-journey-ratchet] first-token environment: viewport=');
  }, 90_000);
});
