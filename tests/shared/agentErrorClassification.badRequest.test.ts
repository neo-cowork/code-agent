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

  it('a JSON 400 or 422 with a non-empty body is bad_request', () => {
    expect(classifyAgentError({
      message: '{"code":"MODEL_CALL_FAILED","message":"reasoning_effort is not supported"}',
      code: 'RUN_FAILED',
      httpStatus: 400,
    })?.category).toBe('bad_request');
    expect(classifyAgentError({
      message: 'the relay rejected this model request',
      code: 'RUN_FAILED',
      statusCode: 422,
    })?.category).toBe('bad_request');
    expect(classifyAgentError({
      message: 'the relay rejected this model request',
      code: 'RUN_FAILED',
      details: { httpStatus: 400 },
    })?.category).toBe('bad_request');
  });

  it('earlier categories still win over a residual 400', () => {
    expect(classifyAgentError({ message: 'Invalid API Key', code: 'RUN_FAILED', httpStatus: 400 })?.category).toBe('auth');
    expect(classifyAgentError({ message: 'Rate limit reached', code: 'RUN_FAILED', httpStatus: 400 })?.category).toBe('rate_limited');
    expect(classifyAgentError({
      message: 'RESPONSES_FEATURE_NOT_SUPPORTED',
      code: 'RUN_FAILED',
      statusCode: 400,
    })?.category).toBe('request_feature_rejected');
    expect(classify('Bad Request')?.category).toBe('bad_request');
    expect(classify('Invalid request: field "messages[0].content" is required')?.category).toBe('generic');
  });
});
