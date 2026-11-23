// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentErrorMetadata } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

import { AgentErrorPresentation } from '../../../src/renderer/components/features/chat/AgentErrorCard';
import { extractReadableProviderReason } from '../../../src/renderer/utils/genericProviderReason';
import { OPEN_MODEL_SWITCHER_EVENT } from '../../../src/renderer/components/StatusBar/ModelSwitcher';

const error: AgentErrorMetadata = {
  category: 'bad_request',
  code: 'RUN_FAILED',
  rawMessage: 'Bad Request',
  timestamp: 1_720_000_000_000,
};

describe('AgentErrorCard · bad_request (en)', () => {
  afterEach(cleanup);

  it('shows plain copy, a Switch model button and no provider-reason line', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    render(<AgentErrorPresentation error={error} messageId="m1" sessionId="s1" />);
    expect(screen.getByText('This model may not work here')).toBeTruthy();
    expect(screen.getByText(/switch to another model and retry/)).toBeTruthy();
    expect(screen.queryByTestId('agent-error-provider-reason')).toBeNull();
    expect(screen.queryByText(/Bad Request/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Switch model' }));
    expect(spy.mock.calls.some(([e]) => (e as Event).type === OPEN_MODEL_SWITCHER_EVENT)).toBe(true);
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  });

  it('extractReadableProviderReason drops empty phrases but keeps informative text', () => {
    expect(extractReadableProviderReason('Bad Request', 'en')).toBeNull();
    expect(extractReadableProviderReason('invalid request.', 'en')).toBeNull();
    expect(extractReadableProviderReason('Upstream service is temporarily under maintenance', 'en'))
      .toBe('Upstream service is temporarily under maintenance');
  });
});
