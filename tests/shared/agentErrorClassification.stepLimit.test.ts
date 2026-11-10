import { describe, expect, it } from 'vitest';
import { RUN_ERROR_CODE_MAX_ITERATIONS } from '../../src/shared/constants';
import { classifyAgentError, isTerminalAgentError } from '../../src/shared/utils/agentErrorClassification';

describe('classifyAgentError foreground step limit', () => {
  const error = { code: RUN_ERROR_CODE_MAX_ITERATIONS, message: 'Max iterations reached' };

  it('suppresses the foreground step-limit failure card while preserving terminal cleanup', () => {
    const payload = { ...error, details: { stoppedByStepLimit: true } };
    expect(classifyAgentError(payload)).toBeNull();
    expect(classifyAgentError({ data: payload, sessionId: 'session' })).toBeNull();
    expect(isTerminalAgentError(payload)).toBe(true);
  });

  it.each([undefined, {}, { stoppedByStepLimit: false }, { stoppedByStepLimit: 'true' }, null])(
    'keeps a background/no-marker step-limit failure card (%j)', (details) => {
      expect(classifyAgentError({ ...error, details })).toMatchObject({
        category: 'generic', code: RUN_ERROR_CODE_MAX_ITERATIONS, rawMessage: error.message,
      });
    },
  );

  it('does not suppress a different failure just because it carries the marker', () => {
    expect(classifyAgentError({ ...error, code: 'RUN_FAILED', details: { stoppedByStepLimit: true } }))
      .toMatchObject({ category: 'generic', code: 'RUN_FAILED' });
  });
});
