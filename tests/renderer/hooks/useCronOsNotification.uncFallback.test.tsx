// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS, type NotificationShowEvent } from '../../../src/shared/ipc';
import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useWorkbenchFocusStore } from '../../../src/renderer/stores/workbenchFocusStore';

// Real hook, OS notification utility, and toast store. Fake the Tauri and host transports.
const denial = { backend: 'unc', ok: false, reason: 'UNErrorDomain 1 Notifications are not allowed' };
const denialReport = { mode: 'tauri', backend: 'unc', error: denial.reason };
const viewAction = { label: '查看', onClick: expect.any(Function) };
let show: ((event: NotificationShowEvent) => void) | undefined;

const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>, _options?: unknown) => {
  if (command === 'post_system_notification') return denial;
  if (command === 'plugin:event|listen') return 1;
  if (command === 'plugin:event|unlisten' || command === 'plugin:notification|register_listener'
    || command === 'plugin:notification|remove_listener') return;
  throw new Error(`Unexpected native invoke: ${command}`);
});

const domainInvoke = vi.fn(async (_domain: string, action: string, _payload?: unknown) => {
  if (action === 'reportClientDelivery') return { success: true, data: null };
  throw new Error(`Unexpected domain action: ${action}`);
});

const completion: NotificationShowEvent = {
  id: 'completion', title: '任务完成 - 周报', body: '周报已生成', sessionId: 'report-session',
};
const meeting: NotificationShowEvent = {
  id: 'meeting', title: '会议即将开始', body: '项目周会', sessionId: '', urgent: true,
};
const failure: NotificationShowEvent = {
  id: 'failure', title: '任务失败 - 周报', body: '周报生成失败', sessionId: 'report-session',
  urgent: true, failure: true, markSessionUnread: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  show = undefined;
  useToastStore.setState({ toasts: [] });
  Object.assign(window, {
    __TAURI_INTERNALS__: { invoke, transformCallback: () => 1 },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: vi.fn() },
    codeAgentAPI: {
      on: (channel: string, callback: (event: NotificationShowEvent) => void) => {
        if (channel === IPC_CHANNELS.NOTIFICATION_SHOW) show = callback;
        return () => {};
      },
    },
    domainAPI: { invoke: domainInvoke },
  });
  useAppStore.setState({
    language: 'zh', showSettings: false, showCronCenter: false, showCapabilityHub: false,
    cronCenterRunsRequested: false,
  });
  useSessionStore.setState({ currentSessionId: 'current-session' });
  useWorkbenchFocusStore.setState({ workbenchFocused: false });
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const key of ['__TAURI_INTERNALS__', '__TAURI_EVENT_PLUGIN_INTERNALS__', 'codeAgentAPI', 'domainAPI']) {
    Reflect.deleteProperty(window, key);
  }
});

async function mount() {
  const onOpenSession = vi.fn();
  renderHook(() => useCronOsNotification(cronCenterZh.cronCenter, onOpenSession));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:event|listen',
    expect.objectContaining({ event: 'notification-clicked' }), undefined));
  vi.useFakeTimers();
}

async function deliver(event: NotificationShowEvent, report: typeof denialReport & {
  fallbackToast?: true;
  toastShown?: true;
}) {
  const priorReportCount = domainInvoke.mock.calls.length;
  await act(async () => { show!(event); });
  expect(invoke).toHaveBeenCalledWith('post_system_notification', {
    id: event.id, title: event.title, body: event.body,
  });
  expect(domainInvoke.mock.calls.slice(priorReportCount)).toEqual([
    [IPC_DOMAINS.NOTIFICATION, 'reportClientDelivery', report],
  ]);
}

function focusWindow() {
  vi.mocked(document.hasFocus).mockReturnValue(true);
  act(() => { window.dispatchEvent(new Event('focus')); });
}

describe('UNC authorization denial through useCronOsNotification', () => {
  it('(a) shows a sticky info toast for an unfocused task completion', async () => {
    await mount();
    await deliver(completion, { ...denialReport, fallbackToast: true });
    expect(useToastStore.getState().toasts).toMatchObject([
      { type: 'info', message: '任务完成 - 周报: 周报已生成', duration: 0, action: viewAction },
    ]);
  });

  it('(b) shows a sticky info toast for a focused, visible meeting reminder', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await mount();
    await deliver(meeting, { ...denialReport, fallbackToast: true });
    expect(useToastStore.getState().toasts).toMatchObject([
      { type: 'info', message: '会议即将开始: 项目周会', duration: 0, action: viewAction },
    ]);
  });

  it('(c) shows a warning for an unfocused meeting reminder only on return', async () => {
    await mount();
    await deliver(meeting, denialReport);
    expect(useToastStore.getState().toasts).toEqual([]);

    focusWindow();
    expect(useToastStore.getState().toasts).toMatchObject([
      { type: 'warning', message: '会议即将开始: 项目周会', duration: 10_000, action: viewAction },
    ]);
  });

  it('(d) shows a ten-second error toast immediately for a focused, visible task failure', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await mount();
    await deliver(failure, { ...denialReport, toastShown: true });
    expect(useToastStore.getState().toasts).toMatchObject([
      { type: 'error', message: '任务失败 - 周报: 周报生成失败', duration: 10_000, action: viewAction },
    ]);
  });

  it('(d) shows a ten-second error toast for an unfocused task failure only on return', async () => {
    await mount();
    await deliver(failure, denialReport);
    expect(useToastStore.getState().toasts).toEqual([]);

    focusWindow();
    expect(useToastStore.getState().toasts).toMatchObject([
      { type: 'error', message: '任务失败 - 周报: 周报生成失败', duration: 10_000, action: viewAction },
    ]);
  });

  it('(e) replaces the previous fallback toast with the latest one', async () => {
    await mount();
    await deliver(completion, { ...denialReport, fallbackToast: true });
    const first = useToastStore.getState().toasts;
    expect(first).toHaveLength(1);

    await deliver({ ...completion, id: 'next-completion', body: '新版周报已生成' }, {
      ...denialReport, fallbackToast: true,
    });
    const latest = useToastStore.getState().toasts;
    expect(latest).toMatchObject([{ message: '任务完成 - 周报: 新版周报已生成' }]);
    expect(latest[0].id).not.toBe(first[0].id);
  });

  it('(f) keeps the fallback toast after 60 seconds until closed', async () => {
    await mount();
    await deliver(completion, { ...denialReport, fallbackToast: true });
    const initial = useToastStore.getState().toasts;
    expect(initial).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().toasts).toEqual(initial);

    useToastStore.getState().removeToast(initial[0].id);
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
