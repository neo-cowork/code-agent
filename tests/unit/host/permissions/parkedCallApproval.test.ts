// Evidence class: hermetic-protocol (in-memory credential store; denial registry real).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearParkedCallApprovals, recordParkedCallApproval, resolveParkedCallApproval } from '../../../../src/host/permissions/parkedCallApproval';
import { PARKED_CALL_APPROVAL_TTL_MS } from '../../../../src/shared/constants/envResume';

const args = { subject: 'S', to: ['a@x.com'], content: 'body' };
const ask = (over: Partial<Parameters<typeof resolveParkedCallApproval>[0]> = {}) => resolveParkedCallApproval({
  toolName: 'mail_draft', params: args, sessionId: 's', runId: 'r', blockedByOtherGate: false, ...over,
});
afterEach(() => { clearParkedCallApprovals('r'); clearParkedCallApprovals('r2'); vi.useRealTimers(); });

describe('parked call approval credential', () => {
  it('is consumed once, key order does not matter', () => {
    recordParkedCallApproval({ sessionId: 's', runId: 'r', tool: 'mail_draft', args });
    expect(ask({ params: { content: 'body', to: ['a@x.com'], subject: 'S' } })?.ledgerReason).toBe('parked_call_approval');
    expect(ask()).toBeNull();
  });
  it('only mail_draft is ever recorded (mail_send never)', () => {
    recordParkedCallApproval({ sessionId: 's', runId: 'r', tool: 'mail_send', args });
    expect(ask({ toolName: 'mail_send' })).toBeNull();
  });
  it('any other hard gate still wins and keeps the credential', () => {
    recordParkedCallApproval({ sessionId: 's', runId: 'r', tool: 'mail_draft', args });
    expect(ask({ blockedByOtherGate: true })).toBeNull();
    expect(ask()).not.toBeNull();
  });
  it('different run or session never matches', () => {
    recordParkedCallApproval({ sessionId: 's', runId: 'r', tool: 'mail_draft', args });
    expect(ask({ runId: 'r2' })).toBeNull();
    expect(ask({ sessionId: 's2' })).toBeNull();
  });
  it('expires after the TTL and is cleared with the run', () => {
    vi.useFakeTimers();
    recordParkedCallApproval({ sessionId: 's', runId: 'r', tool: 'mail_draft', args });
    vi.advanceTimersByTime(PARKED_CALL_APPROVAL_TTL_MS + 1);
    expect(ask()).toBeNull();
    recordParkedCallApproval({ sessionId: 's', runId: 'r', tool: 'mail_draft', args });
    clearParkedCallApprovals('r');
    expect(ask()).toBeNull();
  });
});
