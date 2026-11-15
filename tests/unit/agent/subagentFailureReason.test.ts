import { describe, expect, it } from 'vitest';
import { describeSubagentStopReason } from '../../../src/host/agent/subagentFailureReason';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';

describe('describeSubagentStopReason', () => {
  it.each([AgentFailureCode.Timeout, AgentFailureCode.ModelError, AgentFailureCode.Unknown])(
    'suggests retrying only for recoverable cause %s', (code) => {
      expect(describeSubagentStopReason('upstream failed', code)).toContain('回复「继续」');
    });

  it.each([AgentFailureCode.ToolUnavailable, AgentFailureCode.PermissionDenied, AgentFailureCode.BudgetExhausted, AgentFailureCode.ParentGone])(
    'does not tell the user to retry a deterministic failure (%s)', (code) => {
      const text = describeSubagentStopReason('Durable Run persistence is unavailable', code);
      expect(text).not.toContain('继续');
      expect(text).not.toMatch(/Durable|persistence/);
    });
});
