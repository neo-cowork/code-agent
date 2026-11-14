import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { resolveUserRuleOutcomeForTool } from '../../../src/host/permissions/userRuleOutcome';

/** Run through agentRouter.test.ts's real HTTP/send-now routes; only AgentLoop is scripted. */
export function runInitiatingTextProvenanceCases(run: (input: {
  prompt: string;
  memoryTainted?: boolean;
  delegated?: boolean;
  forgedDelegation?: boolean;
}) => Promise<{
  initiatingText: string | undefined;
  trustedDelegation: boolean;
  outcome: ReturnType<typeof resolveUserRuleOutcomeForTool>;
}>): void {
  describe('Web initiating-text provenance', () => {
    const phrase = '确认';
    const prompt = `${phrase}后查一下官网`;

    beforeEach(() => {
      resetPolicyEngine();
      getPolicyEngine().loadUserRules({
        nlRules: [{ behavior: 'preapprove', rule: 'WebFetch', phrases: [phrase] }],
      });
    });
    afterEach(() => resetPolicyEngine());

    it('memoryTainted /api/run text cannot stamp consent or preapprove', async () => {
      const result = await run({ prompt, memoryTainted: true });
      expect(result.initiatingText).toBeUndefined();
      expect(result.outcome).toEqual({ kind: 'ask', rule: 'WebFetch' });
    });

    it('server-marked delegated send-now cannot stamp consent or preapprove', async () => {
      const result = await run({ prompt, delegated: true });
      expect(result.trustedDelegation).toBe(true);
      expect(result.initiatingText).toBeUndefined();
      expect(result.outcome).toEqual({ kind: 'ask', rule: 'WebFetch' });
    });

    it.each([undefined, false])('normal user text retains preapproval (memoryTainted=%s)', async (memoryTainted) => {
      const result = await run({ prompt, memoryTainted });
      expect(result.trustedDelegation).toBe(false);
      expect(result.initiatingText).toBe(prompt);
      expect(result.outcome).toEqual({ kind: 'preapproved', rule: 'WebFetch', phrase });
    });

    it('client context cannot supply the trusted delegation marker', async () => {
      const result = await run({ prompt, forgedDelegation: true });
      expect(result.trustedDelegation).toBe(false);
      expect(result.initiatingText).toBe(prompt);
      expect(result.outcome).toEqual({ kind: 'preapproved', rule: 'WebFetch', phrase });
    });
  });
}
