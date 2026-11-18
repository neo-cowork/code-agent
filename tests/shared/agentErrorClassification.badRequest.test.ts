import { describe, expect, it } from 'vitest';
import { classifyAgentError } from '../../src/shared/utils/agentErrorClassification';

const classify = (message: string) => classifyAgentError({ message, code: 'RUN_FAILED' });

describe('classifyAgentError · bad_request', () => {
  it.each(['Bad Request', 'AI_APICallError: Bad Request', 'invalid request', 'Invalid request.'])(
    'bare %j -> bad_request',
    (message) => {
      expect(classify(message)?.category).toBe('bad_request');
    },
  );

  it('informative 400 text stays generic', () => {
    expect(classify('Invalid request: field "messages[0].content" is required')?.category).toBe('generic');
    expect(classify('Bad Request: model does not support tools')?.category).toBe('generic');
  });

  it('404 and 403 are unchanged', () => {
    expect(classify('Not Found')?.category).toBe('model_not_found');
    expect(classify('Forbidden')?.category).toBe('forbidden');
  });
});
