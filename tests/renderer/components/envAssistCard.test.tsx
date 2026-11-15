// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import type { EnvAssistNotice } from '../../../src/shared/contract/envAssist';

const mocks = vi.hoisted(() => ({ language: 'zh', invoke: vi.fn() }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { languages } = await import('../../../src/renderer/i18n');
  return { useI18n: () => ({ t: languages[mocks.language as 'zh' | 'en'], language: mocks.language }) };
});
vi.mock('../../../src/renderer/services/ipcService', () => ({ invokeDomain: mocks.invoke, default: {} }));
import { AgentErrorPresentation, buildAgentErrorReport } from '../../../src/renderer/components/features/chat/AgentErrorCard';
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
  it.each(['zh', 'en'] as const)('envAssist excludes rawMessage from DOM and public report/copy text (%s)', async (language) => {
    mocks.language = language;
    useAppStore.setState({ developerMode: true });
    const rawMessage = 'raw-env-secret: -1743 osascript Apple events TCC /login /model';
    const error = { category: 'generic' as const, rawMessage, timestamp: 1, envAssist: notice };
    const { container } = render(<AgentErrorPresentation error={error} messageId="m" />);
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1));
    const t = language === 'zh' ? zh : en;
    expect(screen.queryByRole('button', { name: t.agentError.actions.copyReport })).toBeNull();
    expect(container.innerHTML).not.toContain(rawMessage);
    expect(container.textContent).not.toMatch(/raw-env-secret|-1743|osascript|Apple events|TCC|\/login|\/model/i);
    // This existing public builder is the text source used by both copy handlers.
    const report = buildAgentErrorReport({ error, title: 'Safe title', suggestion: 'Safe suggestion', t });
    expect(report).not.toContain(rawMessage);
    expect(report).toBe('');
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
  it.each([['zh', '已允许 Neo 控制「日历」。'], ['en', 'Neo can now control Calendar.']] as const)('a resolved notice shows the done sentence and no button, also after reload (%s)', async (language, done) => {
    mocks.language = language;
    const resolved: EnvAssistNotice = { ...notice, phase: 'resolved', doneKey: 'env.done.calendar', action: undefined, updatedAt: 2 };
    render(<EnvAssistCard notice={resolved} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('domain:envAssist', 'getAvailability'));
    expect(screen.getByTestId('env-assist-card').textContent).toBe(done);
    expect(screen.queryByRole('button')).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith('domain:envAssist', 'recheck', expect.anything());
  });
  it('rechecks on mount and on window focus, and the broadcast resolved notice replaces the button', async () => {
    render(<EnvAssistCard notice={notice} />);
    await screen.findByRole('button');
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('domain:envAssist', 'recheck', { noticeId: notice.id }));
    mocks.invoke.mockClear();
    window.dispatchEvent(new Event('focus'));
    expect(mocks.invoke).toHaveBeenCalledWith('domain:envAssist', 'recheck', { noticeId: notice.id });
    act(() => useEnvAssistStore.getState().report({ ...notice, phase: 'resolved', doneKey: 'env.done.calendar', action: undefined, updatedAt: 2 }));
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
    expect(screen.getByTestId('env-assist-card').textContent).toBe('已允许 Neo 控制「日历」。');
  });
  it('does not render host diagnostics or forged copy keys and parameters', async () => {
    render(<EnvAssistCard notice={{ ...notice, sentenceKey: 'osascript', sentenceParams: { raw: '-1743' }, devDiagnostic: { rawRef: 'TCC' } }} />);
    expect(screen.getByTestId('env-assist-card').textContent).not.toMatch(/-1743|osascript|TCC/);
  });
  it.each([
    ['zh', 'helperScreen', 'screenCapture', '要查看你的屏幕，需要你允许 Neo 的电脑控制助手录制屏幕。', '允许查看屏幕'],
    ['en', 'helperComputer', 'accessibility', "To use your computer, Neo's computer-control helper needs your OK to use accessibility features.", 'Allow accessibility'],
  ] as const)('cua helper notice renders one sentence and one Allow button, no ids or raw text (%s/%s)', async (language, target, pane, sentence, button) => {
    mocks.language = language;
    const cua: EnvAssistNotice = {
      ...notice, id: `run|perm|${target}`, class: pane === 'screenCapture' ? 'perm_screen_recording' : 'perm_accessibility',
      target: { id: target, labelKey: `env.target.${target}` }, sentenceKey: `env.sentence.${target}`,
      action: { kind: 'request_grant', labelKey: `env.allow.${target}`, payload: { pane } },
    };
    render(<EnvAssistCard notice={cua} />);
    const view = await screen.findByRole('button');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByTestId('env-assist-card').querySelector('p')!.textContent).toBe(sentence);
    expect(view.textContent).toBe(button);
    expect(screen.getByTestId('env-assist-card').textContent).not.toMatch(/com\.agentneo|mcp__|cua-driver|check_permissions|\.app/i);
    fireEvent.click(view);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('domain:envAssist', 'act', { noticeId: cua.id, actionKind: 'request_grant', payload: { pane } }));
  });
});
