// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS, type NotificationShowEvent } from '../../../src/shared/ipc';
import type { ParkedApprovalInboxItem } from '../../../src/shared/contract/pendingApproval';
import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useWorkbenchFocusStore } from '../../../src/renderer/stores/workbenchFocusStore';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';

// Real hook, postOsNotification, IPC facades, plugin module, stores and routing.
// Only the shell invoke/listen and host IPC transport boundaries are faked.
const callbacks = new Map<number, (event: unknown) => void>();
let show: ((event: NotificationShowEvent) => void) | undefined;
let parked: ParkedApprovalInboxItem[];
let result: { backend: 'unc'; ok: boolean; reason?: string };
const invoke = vi.fn(async (command: string, args?: Record<string, unknown>, _options?: unknown) => {
  if (command === 'post_system_notification') return result;
  if (command === 'plugin:event|listen') return 1;
  if (command === 'plugin:event|unlisten' || command === 'plugin:notification|register_listener'
    || command === 'plugin:notification|remove_listener') return;
  throw new Error(`Unexpected native invoke: ${command} ${JSON.stringify(args)}`);
});
const domainInvoke = vi.fn(async (_domain: string, action: string, _payload?: unknown) => {
  if (action === 'listParkedApprovals') return { success: true, data: parked };
  if (action === 'reportClientDelivery') return { success: true, data: null };
  throw new Error(`Unexpected domain action: ${action}`);
});

beforeEach(() => {
  callbacks.clear();
  show = undefined;
  parked = [];
  useToastStore.setState({ toasts: [] });
  result = { backend: 'unc', ok: true };
  vi.clearAllMocks();
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      invoke,
      transformCallback: (callback: (event: unknown) => void) => {
        const id = callbacks.size + 1;
        callbacks.set(id, callback);
        return id;
      },
    },
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
  useSessionStore.setState({ currentSessionId: 'S1' });
  useWorkbenchFocusStore.setState({ workbenchFocused: false });
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});

afterEach(() => {
  cleanup();
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
  return onOpenSession;
}

async function deliver(event: NotificationShowEvent) {
  act(() => show!(event));
  await waitFor(() => expect(domainInvoke).toHaveBeenCalledWith(IPC_DOMAINS.NOTIFICATION,
    'reportClientDelivery', expect.any(Object)));
}

async function click(id: string) {
  const registration = invoke.mock.calls.find(([command]) => command === 'plugin:event|listen')!;
  const callbackId = registration[1]!.handler as number;
  await act(async () => { callbacks.get(callbackId)!({ payload: { id } }); });
}

function trace(label: string, onOpenSession: ReturnType<typeof vi.fn>) {
  process.stdout.write(`${label} ${JSON.stringify({
    invoke: invoke.mock.calls.filter(([command]) => command === 'post_system_notification'),
    delivery: domainInvoke.mock.calls.filter(([, action]) => action === 'reportClientDelivery'),
    onOpenSession: onOpenSession.mock.calls,
    automation: {
      showCronCenter: useAppStore.getState().showCronCenter,
      cronCenterRunsRequested: useAppStore.getState().cronCenterRunsRequested,
    },
  })}\n`);
}

describe('UNC real notification chain', () => {
  it('③ unfocused completion passes id X and the native click opens its session', async () => {
    const onOpenSession = await mount();
    const event = { id: 'X', title: '任务完成', body: '完成了', sessionId: 'completion-session' };
    await deliver(event);
    expect(invoke).toHaveBeenCalledWith('post_system_notification', {
      title: event.title, body: event.body, id: 'X',
    });
    // A newer banner must not steal the earlier banner's click destination.
    await deliver({ ...event, id: 'newer', sessionId: 'newer-session' });
    await click('X');
    expect(onOpenSession.mock.calls).toEqual([['completion-session']]);
    trace('PATH_A', onOpenSession);
  });

  it.each([true, false])('④ focused S1 needs-input S2 routes with pending approval=%s', async (pending) => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    parked = [{ id: 'approval', sessionId: 'S2', tool: 'write_file', requestedAt: 1,
      status: pending ? 'pending' : 'orphaned' }];
    const onOpenSession = await mount();
    const event = { id: 'needs-S2', title: '需要你确认', body: '请确认', sessionId: 'S2', urgent: true };
    await deliver(event);
    expect(invoke).toHaveBeenCalledWith('post_system_notification', {
      title: event.title, body: event.body, id: event.id,
    });
    const reports = domainInvoke.mock.calls.filter(([, action]) => action === 'reportClientDelivery');
    expect(reports).toHaveLength(1);
    expect(reports[0][2]).toEqual({ mode: 'tauri', backend: 'unc', dispatched: true, urgent: true });
    expect(reports[0][2]).not.toMatchObject({ mode: 'suppressed-viewing' });
    const openRuns = vi.spyOn(useAppStore.getState(), 'openCronCenterRuns');
    await click(event.id);
    expect(domainInvoke).toHaveBeenCalledWith(IPC_DOMAINS.SESSION_AUTOMATION, 'listParkedApprovals', {});
    expect(openRuns).toHaveBeenCalledTimes(pending ? 1 : 0);
    expect(onOpenSession.mock.calls).toEqual(pending ? [] : [['S2']]);
    expect(useAppStore.getState().showCronCenter).toBe(pending);
    expect(useAppStore.getState().cronCenterRunsRequested).toBe(pending);
    trace(`PATH_B pending=${pending} openCronCenterRuns=${openRuns.mock.calls.length}`, onOpenSession);
  });

  it('⑦ foreground failure retains the toast alongside the UNC banner request', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    const onOpenSession = await mount();
    await deliver({ id: 'failure', title: '任务未完成', body: '请查看', sessionId: 'S2', urgent: true, failure: true });
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({
      type: 'error', message: '任务未完成: 请查看', action: expect.objectContaining({ label: '查看' }),
    })]);
    expect(domainInvoke).toHaveBeenCalledWith(IPC_DOMAINS.NOTIFICATION, 'reportClientDelivery', {
      mode: 'tauri', backend: 'unc', dispatched: true, urgent: true, toastShown: true,
    });
    trace('FOREGROUND_FAILURE_TOAST_AND_BANNER_REQUEST', onOpenSession);
  });

  it('⑤ FB-928 UNC rejection reports error and never dispatched:true', async () => {
    result = { backend: 'unc', ok: false, reason: 'UNC rejected request' };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onOpenSession = await mount();
    await deliver({ id: 'rejected', title: '任务完成', body: '完成了', sessionId: 'S2' });
    const reports = domainInvoke.mock.calls.filter(([, action]) => action === 'reportClientDelivery');
    expect(reports).toHaveLength(1);
    expect(reports[0][2]).toEqual({ mode: 'tauri', backend: 'unc', error: 'UNC rejected request' });
    expect(reports[0][2]).not.toHaveProperty('dispatched', true);
    expect(invoke.mock.calls.some(([command]) => command === 'plugin:notification|notify')).toBe(false);
    trace('FB_928', onOpenSession);
  });
});
