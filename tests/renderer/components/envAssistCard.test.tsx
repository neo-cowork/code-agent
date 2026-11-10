// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvAssistNotice } from '../../../src/shared/contract/envAssist';

const mocks = vi.hoisted(() => ({ language: 'zh', invoke: vi.fn() }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { languages } = await import('../../../src/renderer/i18n');
  return { useI18n: () => ({ t: languages[mocks.language as 'zh' | 'en'], language: mocks.language }) };
});
vi.mock('../../../src/renderer/services/ipcService', () => ({ invokeDomain: mocks.invoke, default: {} }));
import { AgentErrorPresentation } from '../../../src/renderer/components/features/chat/AgentErrorCard';
import { EnvAssistCard } from '../../../src/renderer/components/features/chat/EnvAssistCard';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useEnvAssistStore } from '../../../src/renderer/stores/envAssistStore';

const notice: EnvAssistNotice = {
  id: 'run|perm_automation|calendar', sessionId: 'session', runId: 'run', class: 'perm_automation',
  target: { id: 'calendar', labelKey: 'env.target.calendar' }, phase: 'needs_user',
  sentenceKey: 'env.sentence.calendar', action: { kind: 'open_settings_pane', labelKey: 'env.allow.calendar', payload: { pane: 'automation' } },
  resume: { mode: 'manual' }, updatedAt: 1,
};
beforeEach(() => {
  useEnvAssistStore.setState({ notices: {} }); mocks.language = 'zh';
  mocks.invoke.mockReset().mockImplementation(async (_domain, action) => action === 'getAvailability' ? { available: true } : { status: 'opened' });
});
afterEach(cleanup);

describe('EnvAssistCard', () => {
  it.each(['zh', 'en'])('renders one sentence and one button without diagnostics even in developer mode (%s)', async (language) => {
    mocks.language = language;
    useAppStore.setState({ developerMode: true });
    const { container } = render(<AgentErrorPresentation error={{ category: 'generic', rawMessage: 'osascript -1743 Apple events TCC /system/path', code: 'internal', modelId: 'engine-internal', timestamp: 1, envAssist: notice }} messageId="m" />);
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1));
    expect(container.textContent).not.toMatch(/-1743|osascript|Apple events|TCC|engine-internal|internal|\/system/i);
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(screen.getByRole('button').textContent).toBe(language === 'en' ? 'Allow Calendar' : '允许访问日历');
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('domain:envAssist', 'act', { noticeId: notice.id, actionKind: 'open_settings_pane', payload: { pane: 'automation' } }));
  });
  it('hides the button without a desktop and after an unavailable action', async () => {
    mocks.invoke.mockResolvedValue({ available: false });
    const view = render(<EnvAssistCard notice={notice} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    expect(screen.queryByRole('button')).toBeNull();
    view.unmount();
    mocks.invoke.mockImplementation(async (_domain, action) => action === 'getAvailability' ? { available: true } : { status: 'not_available' });
    render(<EnvAssistCard notice={notice} />);
    fireEvent.click(await screen.findByRole('button'));
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
    expect(screen.getByTestId('env-assist-card').textContent).toBe('要看你的日程，需要你允许 Neo 控制「日历」。');
  });
  it('does not render host diagnostics or forged copy keys and parameters', async () => {
    render(<EnvAssistCard notice={{ ...notice, sentenceKey: 'osascript', sentenceParams: { raw: '-1743' }, devDiagnostic: { rawRef: 'TCC' } }} />);
    expect(screen.getByTestId('env-assist-card').textContent).not.toMatch(/-1743|osascript|TCC/);
  });
});
