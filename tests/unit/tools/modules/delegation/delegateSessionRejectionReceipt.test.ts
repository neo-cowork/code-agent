import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../../../../src/host/tools/protocolRegistry';
import { executePocToolViaProtocol } from '../../../../../src/host/tools/dispatch/shadowAdapter';
import { humanizeToolFailureReason } from '../../../../../src/renderer/utils/toolExecutionPresentation';
import { en } from '../../../../../src/renderer/i18n/en';
import { zh } from '../../../../../src/renderer/i18n/zh';

const CODES = [
  'target_unavailable', 'not_delegatable', 'self_route', 'candidate_set_stale', 'idempotency_conflict',
  'workspace_boundary', 'write_conflict', 'unauthorized_workspace', 'target_busy', 'target_permission_mode',
  'untrusted_workspace', 'ambiguous', 'invalid_call',
];

async function rejectedCall() {
  const result = await executePocToolViaProtocol({
    toolName: 'delegate_session',
    params: { action: 'create_new' },
    workingDirectory: '/workspace/origin',
    requestPermission: async () => true,
    sessionId: 'origin',
  });
  return { name: 'delegate_session', result: { toolCallId: 'tool-1', success: result.success, error: result.error, metadata: result.metadata } } as never;
}

describe('delegate_session rejection receipt copy', () => {
  const prev = process.env.CODE_AGENT_CROSS_SESSION_DELEGATION;
  beforeEach(() => { process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1'; });
  afterEach(() => {
    if (prev === undefined) delete process.env.CODE_AGENT_CROSS_SESSION_DELEGATION;
    else process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = prev;
  });

  it('en: invalid_call from the production chain renders one plain sentence', async () => {
    const call = await rejectedCall();
    expect((call as { result: { metadata: { code: string } } }).result.metadata.code).toBe('invalid_call');
    const reason = humanizeToolFailureReason(call, en);
    expect(reason).toBe(en.toolStepHumanize.delegationRejectionCodes.invalid_call);
    expect(reason).not.toMatch(/Error code|invalid_call/);
  });

  it('zh: invalid_call from the production chain renders the zh sentence', async () => {
    const reason = humanizeToolFailureReason(await rejectedCall(), zh);
    expect(reason).toBe(zh.toolStepHumanize.delegationRejectionCodes.invalid_call);
    expect(reason).not.toContain('错误码');
  });

  it('every rejection code has en and zh copy without the code name; unknown codes use the fallback', () => {
    for (const code of CODES) {
      for (const t of [en, zh]) {
        const table = t.toolStepHumanize.delegationRejectionCodes as Record<string, string>;
        expect(table[code]?.length, code).toBeGreaterThan(0);
        expect(table[code]).not.toContain(code);
        const call = { name: 'delegate_session', result: { toolCallId: 'x', success: false, metadata: { code } } } as never;
        expect(humanizeToolFailureReason(call, t)).toBe(table[code]);
      }
    }
    const odd = { name: 'delegate_session', result: { toolCallId: 'x', success: false, metadata: { code: 'delegation_not_active' } } } as never;
    expect(humanizeToolFailureReason(odd, en)).toBe(en.toolStepHumanize.delegationRejectionFallback);
  });
});
