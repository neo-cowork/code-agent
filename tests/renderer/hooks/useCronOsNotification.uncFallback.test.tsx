// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS, type NotificationShowEvent } from '../../../src/shared/ipc';
import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';
import { postOsNotification } from '../../../src/renderer/utils/osNotification';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';
import * as nativeDesktopModule from '../../../src/renderer/services/nativeDesktop';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useWorkbenchFocusStore } from '../../../src/renderer/stores/workbenchFocusStore';

// Real hook, OS notification utility, and toast store. Fake the Tauri and host transports.
// reason 用 Rust 壳的真实形状（native_notification.rs:482 把 UNErrorDomain 详情拼在前缀后面）。
const denialReason = 'UNUserNotificationCenter authorization request failed: UNErrorDomain 1 Notifications are not allowed';
const denial = { backend: 'unc', ok: false, reason: denialReason };
const denialReport = { mode: 'tauri', backend: 'unc', error: denialReason };
const successReport = { mode: 'tauri', backend: 'unc', dispatched: true };
const viewAction = { label: '查看', onClick: expect.any(Function) };
const deniedNoticeToast = {
  type: 'error',
  message: '系统通知已被关闭，任务提醒不会弹出',
  duration: 0,
  action: { label: '去开启', onClick: expect.any(Function) },
};
let uncResult: { backend: string; ok: boolean; reason?: string } = denial;
let show: ((event: NotificationShowEvent) => void) | undefined;

const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>, _options?: unknown) => {
  if (command === 'post_system_notification') return uncResult;
  if (command === 'desktop_open_system_settings') return true;
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
  uncResult = denial;
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

// 「已提示过系统通知被关」是 osNotification 的模块级状态，跨用例存活。每个用例先真发一条
// 成功 UNC（与产线同一复位路径）把它复位，保证各用例从同一状态出发。
async function resetDeniedNoticeBySuccessfulSend() {
  uncResult = { backend: 'unc', ok: true };
  await act(async () => { await postOsNotification({ title: '权限探针', body: '复位' }, { urgent: true }); });
  uncResult = denial;
  useToastStore.setState({ toasts: [] });
}

async function mount() {
  const onOpenSession = vi.fn();
  renderHook(() => useCronOsNotification(cronCenterZh.cronCenter, onOpenSession));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:event|listen',
    expect.objectContaining({ event: 'notification-clicked' }), undefined));
  await resetDeniedNoticeBySuccessfulSend();
  vi.useFakeTimers();
}

async function deliver(event: NotificationShowEvent, report: Record<string, unknown>) {
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
      deniedNoticeToast,
    ]);
  });

  it('(b) shows a sticky info toast for a focused, visible meeting reminder', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await mount();
    await deliver(meeting, { ...denialReport, fallbackToast: true });
    expect(useToastStore.getState().toasts).toMatchObject([
      { type: 'info', message: '会议即将开始: 项目周会', duration: 0, action: viewAction },
      deniedNoticeToast,
    ]);
  });

  it('(c) shows a warning for an unfocused meeting reminder only on return', async () => {
    await mount();
    await deliver(meeting, denialReport);
    expect(useToastStore.getState().toasts).toMatchObject([deniedNoticeToast]);

    focusWindow();
    expect(useToastStore.getState().toasts).toMatchObject([
      deniedNoticeToast,
      { type: 'warning', message: '会议即将开始: 项目周会', duration: 10_000, action: viewAction },
    ]);
  });

  it('(d) shows a ten-second error toast immediately for a focused, visible task failure', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await mount();
    await deliver(failure, { ...denialReport, toastShown: true });
    expect(useToastStore.getState().toasts).toMatchObject([
      { type: 'error', message: '任务失败 - 周报: 周报生成失败', duration: 10_000, action: viewAction },
      deniedNoticeToast,
    ]);
  });

  it('(d) shows a ten-second error toast for an unfocused task failure only on return', async () => {
    await mount();
    await deliver(failure, denialReport);
    expect(useToastStore.getState().toasts).toMatchObject([deniedNoticeToast]);

    focusWindow();
    expect(useToastStore.getState().toasts).toMatchObject([
      deniedNoticeToast,
      { type: 'error', message: '任务失败 - 周报: 周报生成失败', duration: 10_000, action: viewAction },
    ]);
  });

  it('(e) replaces the previous fallback toast with the latest one', async () => {
    await mount();
    await deliver(completion, { ...denialReport, fallbackToast: true });
    const first = useToastStore.getState().toasts;
    expect(first).toHaveLength(2);

    await deliver({ ...completion, id: 'next-completion', body: '新版周报已生成' }, {
      ...denialReport, fallbackToast: true,
    });
    const latest = useToastStore.getState().toasts;
    // 事件 toast 换成最新一条；「去开启」提示原样保留
    expect(latest).toMatchObject([deniedNoticeToast, { message: '任务完成 - 周报: 新版周报已生成' }]);
    expect(latest[1].id).not.toBe(first[0].id);
    expect(latest[0].id).toBe(first[1].id);
  });

  it('(f) keeps the fallback toast after 60 seconds until closed', async () => {
    await mount();
    await deliver(completion, { ...denialReport, fallbackToast: true });
    const initial = useToastStore.getState().toasts;
    expect(initial).toHaveLength(2);

    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().toasts).toEqual(initial);

    for (const t of initial) useToastStore.getState().removeToast(t.id);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('(g) repeated denials keep exactly one denial notice while it is open', async () => {
    await mount();
    await deliver(completion, { ...denialReport, fallbackToast: true });
    const firstNotice = useToastStore.getState().toasts.find((t) => t.type === 'error')!;

    await deliver({ ...completion, id: 'next-completion', body: '第二版周报已生成' }, {
      ...denialReport, fallbackToast: true,
    });
    const errors = useToastStore.getState().toasts.filter((t) => t.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].id).toBe(firstNotice.id);
  });

  it('(h) does not re-show the notice the user already closed', async () => {
    await mount();
    await deliver(completion, { ...denialReport, fallbackToast: true });
    const notice = useToastStore.getState().toasts.find((t) => t.type === 'error')!;
    useToastStore.getState().removeToast(notice.id);

    await deliver({ ...completion, id: 'next-completion', body: '第二版周报已生成' }, {
      ...denialReport, fallbackToast: true,
    });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ type: 'info', message: '任务完成 - 周报: 第二版周报已生成' });
  });

  it('(i) shows the notice again only after a successful UNC send', async () => {
    await mount();
    await deliver(completion, { ...denialReport, fallbackToast: true });
    expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true);

    uncResult = { backend: 'unc', ok: true };
    await deliver({ ...completion, id: 'recovered' }, successReport);
    // 成功发送：提示撤下，只剩事件自己的 fallback toast
    expect(useToastStore.getState().toasts).toMatchObject([
      { type: 'info', message: '任务完成 - 周报: 周报已生成' },
    ]);

    uncResult = denial;
    await deliver({ ...completion, id: 'denied-again' }, { ...denialReport, fallbackToast: true });
    expect(useToastStore.getState().toasts).toMatchObject([
      { type: 'info', message: '任务完成 - 周报: 周报已生成' },
      deniedNoticeToast,
    ]);
  });

  it('(j) shows no notice for a non-authorization failure reason', async () => {
    await mount();
    uncResult = { backend: 'unc', ok: false, reason: 'UNUserNotificationCenter authorization timed out' };
    await deliver(completion, {
      mode: 'tauri', backend: 'unc', error: 'UNUserNotificationCenter authorization timed out', fallbackToast: true,
    });
    expect(useToastStore.getState().toasts).toMatchObject([
      { type: 'info', message: '任务完成 - 周报: 周报已生成', duration: 0, action: viewAction },
    ]);
  });

  it('(k) notice action opens Notifications settings and removes the notice', async () => {
    const openSettings = vi.spyOn(nativeDesktopModule, 'openNativeDesktopSystemSettings');
    await mount();
    await deliver(completion, { ...denialReport, fallbackToast: true });
    const notice = useToastStore.getState().toasts.find((t) => t.type === 'error')!;

    await act(async () => { notice.action!.onClick(); });
    expect(openSettings).toHaveBeenCalledWith('notifications');
    expect(invoke).toHaveBeenCalledWith('desktop_open_system_settings', { request: { kind: 'notifications' } });
    expect(useToastStore.getState().toasts.some((t) => t.id === notice.id)).toBe(false);
  });
});
