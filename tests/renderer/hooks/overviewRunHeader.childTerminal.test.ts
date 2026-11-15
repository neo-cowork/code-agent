import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { RunUiState } from '../../../src/renderer/types/runWorkbench';
import { buildOverviewRunHeaderModel, hasFailedCurrentRequest } from '../../../src/renderer/utils/overviewRunHeader';

describe('task card child lifetime presentation', () => {
  const run = { identity: { turnId: 'turn' }, status: 'completed', title: 'Create the sales presentation', phase: 'Completed', startedAt: 1, endedAt: 5 } as RunUiState;
  it('keeps a live dot while a failed request has a live background child, then removes the green completion dot after the child ends', () => {
    const live = buildOverviewRunHeaderModel({ run, now: 10, primaryFailed: true, backgroundChildren: 1 });
    expect(live?.tone).toBe('live');
    expect(live?.live).toBe(true);
    const ended = buildOverviewRunHeaderModel({ run, now: 11, primaryFailed: true, backgroundChildren: 0 });
    expect(ended?.tone).toBe('error');
    expect(ended?.status).toBe('blocked');
    expect(ended?.live).toBe(false);
    expect(buildOverviewRunHeaderModel({ run: { ...run, status: 'running' }, now: 11, primaryFailed: true, backgroundChildren: 0 })?.tone).toBe('error');
    expect(buildOverviewRunHeaderModel({ run, now: 11 })?.tone).toBe('done');
  });
  it('retains the actual user-request failure across an invisible completion wake and clears it on a new user request', () => {
    const user = { id: 'user', role: 'user', content: 'Create sales slides', timestamp: 1 } as Message;
    const failure = { id: 'failed', role: 'assistant', content: '', timestamp: 2, metadata: { agentError: { category: 'generic' } } } as Message;
    const wake = { id: 'wake', role: 'user', content: 'Background child finished', timestamp: 3, isMeta: true } as Message;
    expect(hasFailedCurrentRequest([user, failure, wake])).toBe(true);
    expect(hasFailedCurrentRequest([user, failure, wake, { ...user, id: 'new-user', timestamp: 4 }])).toBe(false);
  });
});
