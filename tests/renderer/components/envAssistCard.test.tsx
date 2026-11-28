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
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

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
  it.each([['zh', '已按你刚才的确认保存草稿。'], ['en', 'Saved the draft as you confirmed a moment ago.']])('shows the reused-confirmation line in plain words (%s)', (language, line) => {
    mocks.language = language;
    const reused: EnvAssistNotice = { ...notice, id: 'run|parked_reuse|c', target: { id: 'mail', labelKey: 'env.target.mail' }, phase: 'resolved', sentenceKey: 'env.reused.mail', action: undefined };
    const { container } = render(<EnvAssistCard notice={reused} />);
    expect(container.textContent).toBe(line);
    expect(container.textContent).not.toMatch(/mail_draft|env\.|run\|/);
  });

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
  it('a card resolved elsewhere while the chat missed the broadcast (settings page open) turns done on remount, no button', async () => {
    const resolved: EnvAssistNotice = { ...notice, phase: 'resolved', doneKey: 'env.done.calendar', updatedAt: 2, action: undefined };
    mocks.invoke.mockImplementation(async (_domain, action) => action === 'getAvailability' ? { available: true }
      : action === 'recheck' ? { status: 'checked', outcome: { status: 'granted' }, notice: resolved } : { status: 'opened' });
    render(<EnvAssistCard notice={notice} />); // stale snapshot from the renderer's message cache
    await waitFor(() => expect(screen.getByTestId('env-assist-card').textContent).toBe('已允许 Neo 访问「日历」。'));
    expect(screen.queryByRole('button')).toBeNull();
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
    expect(screen.getByTestId('env-assist-card').textContent).toBe('要看你的日程，需要你允许 Neo 访问「日历」。');
  });
  it.each([['zh', '已允许 Neo 访问「日历」。'], ['en', 'Neo can now access Calendar.']] as const)('a resolved notice shows the done sentence and no button, also after reload (%s)', async (language, done) => {
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
    expect(screen.getByTestId('env-assist-card').textContent).toBe('已允许 Neo 访问「日历」。');
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
  // N-FIX-STEP-HEADER-AND-STOPPED-ROW-REPEAT：停车等授权的那一轮，卡上说清「允许后会自动接着做」，
  // 输入框上方不再另起一行重复；不属于停车 run 的卡（不会自动续做的失败路径）不许这么说。
  it.each(['zh', 'en'] as const)('says the task picks back up by itself only for the parked run (%s)', async (language) => {
    mocks.language = language;
    const t = language === 'zh' ? zh : en;
    const parked = { runId: 'run', mode: 'continue', interruptCause: 'env_blocked', autoResumeCount: 0, maxAutoResumeCount: 3, canContinue: true,
      envBlocked: { class: 'perm_automation', target: 'calendar', toolCallId: 'c1' } };
    useSessionStore.setState({ sessions: [{ id: 'session', title: 't', createdAt: 1, updatedAt: 1, durableResume: parked }] as never });
    const { unmount } = render(<EnvAssistCard notice={notice} />);
    expect(screen.getByTestId('env-assist-card').textContent).toContain(`${t.env.sentence.calendar}${t.env.autoResume}`);
    unmount();
    useSessionStore.setState({ sessions: [{ id: 'session', title: 't', createdAt: 1, updatedAt: 1, durableResume: { ...parked, runId: 'other' } }] as never });
    render(<EnvAssistCard notice={notice} />);
    expect(screen.getByTestId('env-assist-card').textContent).not.toContain(t.env.autoResume);
    useSessionStore.setState({ sessions: [] });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
  });

  describe('login_expired card (S7)', () => {
    const loginNotice = (over: Partial<EnvAssistNotice> = {}): EnvAssistNotice => ({
      id: 'run|login_expired|feishu',
      sessionId: 'session',
      runId: 'run',
      class: 'login_expired',
      target: { id: 'feishu', labelKey: 'env.target.feishu' },
      phase: 'needs_user',
      sentenceKey: 'env.sentence.loginExpired',
      action: { kind: 'reauthorize', labelKey: 'env.allow.loginExpired', payload: { serverName: 'feishu' } },
      resume: { mode: 'auto' },
      updatedAt: 1,
      ...over,
    });

    it.each([
      ['zh', '「飞书」登录过期了，重新登录后我会继续。', '重新登录'],
      ['en', 'Feishu sign-in expired — sign in and I will continue.', 'Sign in again'],
    ] as const)('renders one sentence and one Sign in again button even without desktop settings availability (%s)', async (language, expectedSentence, expectedButton) => {
      mocks.language = language;
      mocks.invoke.mockImplementation(async (_domain, action) => (
        action === 'getAvailability' ? { available: false } : { status: 'checked', outcome: { status: 'denied' } }
      ));
      const { container } = render(<EnvAssistCard notice={loginNotice()} />);
      const buttons = await screen.findAllByRole('button');
      expect(buttons).toHaveLength(1);
      expect(container.querySelectorAll('p')).toHaveLength(1);
      expect(container.querySelector('p')!.textContent).toBe(expectedSentence);
      expect(buttons[0].textContent).toBe(expectedButton);
      expect(container.textContent).not.toMatch(/401|oauth|token|cli_not_logged_in|reauthorize|mcp__/i);
      fireEvent.click(buttons[0]);
      await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('domain:envAssist', 'act', {
        noticeId: 'run|login_expired|feishu',
        actionKind: 'reauthorize',
        payload: { serverName: 'feishu' },
      }));
    });

    it.each([
      ['zh', '「飞书」还没登录成功。你可以再试一次，或者这次先不用它。', '再试一次', '这次先跳过', '好的，这次先不用「飞书」。'],
      ['en', 'Feishu is not signed in yet. You can try again, or skip it this time.', 'Try again', 'Skip this time', 'Okay, skipping Feishu this time.'],
    ] as const)('cancel/abandon renders honest copy with Retry and secondary Skip, no internal words (%s)', async (language, expectedSentence, expectedRetry, expectedSkip, expectedDeclined) => {
      mocks.language = language;
      const unconfirmed = loginNotice({
        phase: 'unconfirmed',
        sentenceKey: 'env.sentence.loginUnconfirmed',
        action: { kind: 'reauthorize', labelKey: 'env.retry.loginExpired', payload: { serverName: 'feishu' } },
        updatedAt: 2,
      });
      const declined = loginNotice({
        phase: 'declined',
        sentenceKey: 'env.sentence.loginSkipped',
        action: undefined,
        updatedAt: 3,
      });
      mocks.invoke.mockImplementation(async (_domain, action, payload) => {
        if (action === 'act' && (payload as { actionKind?: string }).actionKind === 'skip_step') {
          return { status: 'checked', outcome: { status: 'denied' }, notice: declined };
        }
        return { status: 'checked', outcome: { status: 'denied' } };
      });
      const { container } = render(<EnvAssistCard notice={unconfirmed} />);
      const buttons = await screen.findAllByRole('button');
      expect(buttons.map((b) => b.textContent)).toEqual([expectedRetry, expectedSkip]);
      expect(container.querySelector('p')!.textContent).toBe(expectedSentence);
      expect(container.textContent).not.toMatch(/401|oauth|token|cli_not_logged_in|unconfirmed|reauthorize|skip_step/i);
      fireEvent.click(buttons[1]);
      await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('domain:envAssist', 'act', {
        noticeId: unconfirmed.id,
        actionKind: 'skip_step',
        payload: { serverName: 'feishu' },
      }));
      await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
      expect(container.querySelector('p')!.textContent).toBe(expectedDeclined);
    });

    it.each([
      ['zh', '已重新登录「notes」。'],
      ['en', 'Signed in to notes again.'],
    ] as const)('resolved custom MCP server renders done sentence with no button (%s)', async (language, expectedDone) => {
      mocks.language = language;
      const resolved = loginNotice({
        id: 'run|login_expired|notes',
        target: { id: 'notes', labelKey: 'env.target.notes' },
        phase: 'resolved',
        doneKey: 'env.done.loginExpired',
        action: undefined,
        updatedAt: 4,
      });
      render(<EnvAssistCard notice={resolved} />);
      expect(screen.getByTestId('env-assist-card').textContent).toBe(expectedDone);
      expect(screen.queryByRole('button')).toBeNull();
    });
  });
});


describe('offline environment card', () => {
  it.each([['zh', zh], ['en', en]] as const)('offers just one manual recheck after the deadline (%s)', async (language, locale) => {
    mocks.language = language;
    const offline: EnvAssistNotice = {
      id: 'run|offline|network', sessionId: 'session', runId: 'run', class: 'offline', phase: 'fixing',
      sentenceKey: 'env.offline.waiting', resume: { mode: 'auto', deadlineAt: Date.now() + 100_000 }, updatedAt: 1,
    };
    const view = render(<EnvAssistCard notice={offline} />);
    expect(screen.getByText(locale.env.offline.waiting)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();

    const expired = { ...offline, resume: { ...offline.resume, deadlineAt: Date.now() - 1 } };
    view.rerender(<EnvAssistCard notice={expired} />);
    expect(await screen.findByText(locale.env.offline.timedOut)).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    mocks.invoke.mockResolvedValueOnce({ status: 'checked', notice: { ...expired, phase: 'resolved', updatedAt: 2 } });
    fireEvent.click(screen.getByRole('button', { name: locale.env.offline.continue }));
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('domain:envAssist', 'recheckOffline', { noticeId: offline.id });
    expect(await screen.findByText(locale.env.offline.resolved)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
