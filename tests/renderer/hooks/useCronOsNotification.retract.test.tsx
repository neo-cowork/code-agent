// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS, type NotificationShowEvent } from '../../../src/shared/ipc';
import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useWorkbenchFocusStore } from '../../../src/renderer/stores/workbenchFocusStore';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';

type NativeResult = { backend: 'unc' | 'legacy-needed'; ok: boolean; reason?: string };

let show: ((event: NotificationShowEvent) => void) | undefined;
let postHandler: (args?: Record<string, unknown>) => Promise<NativeResult>;
let retractHandler: (args?: Record<string, unknown>) => Promise<NativeResult>;

const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  if (command === 'post_system_notification') return postHandler(args);
  if (command === 'retract_system_notification') return retractHandler(args);
  if (command === 'plugin:event|listen') return 1;
  if (
    command === 'plugin:event|unlisten'
    || command === 'plugin:notification|register_listener'
    || command === 'plugin:notification|remove_listener'
  ) {
    return;
  }
  throw new Error(`Unexpected native invoke: ${command} ${JSON.stringify(args)}`);
});

const domainInvoke = vi.fn(async (_domain: string, action: string, _payload?: unknown) => {
  if (action === 'reportClientDelivery') return { success: true, data: null };
  throw new Error(`Unexpected domain action: ${action}`);
});

function installTauriRuntime(): void {
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      invoke,
      transformCallback: () => 1,
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: vi.fn() },
  });
}

beforeEach(() => {
  show = undefined;
  postHandler = async () => ({ backend: 'unc', ok: true });
  retractHandler = async () => ({ backend: 'unc', ok: true });
  vi.clearAllMocks();
  installTauriRuntime();
  Object.assign(window, {
    codeAgentAPI: {
      on: (channel: string, callback: (event: NotificationShowEvent) => void) => {
        if (channel === IPC_CHANNELS.NOTIFICATION_SHOW) show = callback;
        return () => {};
      },
    },
    domainAPI: { invoke: domainInvoke },
  });
  useAppStore.setState({
    language: 'zh',
    showSettings: false,
    showCronCenter: false,
    showCapabilityHub: false,
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

async function mount(): Promise<void> {
  renderHook(() => useCronOsNotification(cronCenterZh.cronCenter, vi.fn()));
  await waitFor(() => expect(show).toBeDefined());
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('useCronOsNotification retract native chain', () => {
  it('retracts a delivered banner by notification id looked up via dedupeKey', async () => {
    await mount();
    act(() => {
      show!({
        id: 'notif-approval-1',
        title: '有操作等你确认',
        body: '无人值守任务请求执行 write_file',
        sessionId: 'S2',
        urgent: true,
        dedupeKey: 'approval-req-1',
      });
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'post_system_notification',
      expect.objectContaining({ id: 'notif-approval-1' }),
    ));

    act(() => {
      show!({
        id: 'retract-1',
        title: '',
        body: '',
        sessionId: '',
        retract: true,
        dedupeKey: 'approval-req-1',
      });
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'retract_system_notification',
      { id: 'notif-approval-1' },
    ));
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      expect.objectContaining({
        mode: 'renderer-early-return',
        reason: 'retract',
        dispatched: false,
        dedupeKey: 'approval-req-1',
        retractedIds: ['notif-approval-1'],
      }),
    );
  });

  it('retracts only the matching dedupeKey when two banners exist', async () => {
    await mount();
    act(() => {
      show!({
        id: 'notif-a',
        title: '有操作等你确认',
        body: '审批 A',
        sessionId: 'S2',
        urgent: true,
        dedupeKey: 'key-a',
      });
      show!({
        id: 'notif-b',
        title: '有操作等你确认',
        body: '审批 B',
        sessionId: 'S3',
        urgent: true,
        dedupeKey: 'key-b',
      });
    });
    await waitFor(() => expect(
      invoke.mock.calls.filter(([cmd]) => cmd === 'post_system_notification'),
    ).toHaveLength(2));

    act(() => {
      show!({
        id: 'retract-a',
        title: '',
        body: '',
        sessionId: '',
        retract: true,
        dedupeKey: 'key-a',
      });
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'retract_system_notification',
      { id: 'notif-a' },
    ));
    await flush();
    const retractCalls = invoke.mock.calls.filter(([cmd]) => cmd === 'retract_system_notification');
    expect(retractCalls).toEqual([['retract_system_notification', { id: 'notif-a' }]]);
  });

  it('waits for an in-flight post_system_notification before invoking retract_system_notification', async () => {
    let resolvePost!: (value: NativeResult) => void;
    const order: string[] = [];
    postHandler = () => new Promise<NativeResult>((resolve) => {
      order.push('post-started');
      resolvePost = (value) => {
        order.push('post-resolved');
        resolve(value);
      };
    });
    retractHandler = async () => {
      order.push('retract-invoked');
      return { backend: 'unc', ok: true };
    };

    await mount();
    act(() => {
      show!({
        id: 'notif-raced',
        title: '有操作等你确认',
        body: '审批等待授权',
        sessionId: 'S2',
        urgent: true,
        dedupeKey: 'key-raced',
      });
    });
    await waitFor(() => expect(order).toEqual(['post-started']));

    act(() => {
      show!({
        id: 'retract-raced',
        title: '',
        body: '',
        sessionId: '',
        retract: true,
        dedupeKey: 'key-raced',
      });
    });
    await flush();
    // Must not have invoked retract while post is still pending.
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'retract_system_notification')).toEqual([]);

    resolvePost({ backend: 'unc', ok: true });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'retract_system_notification',
      { id: 'notif-raced' },
    ));
    expect(order).toEqual(['post-started', 'post-resolved', 'retract-invoked']);
  });

  it('logs a distinguishable console.warn on legacy-needed backend', async () => {
    retractHandler = async () => ({
      backend: 'legacy-needed',
      ok: false,
      reason: 'UNUserNotificationCenter is reserved for macOS app bundles',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();

    act(() => {
      show!({
        id: 'notif-legacy',
        title: '有操作等你确认',
        body: '审批',
        sessionId: 'S2',
        urgent: true,
        dedupeKey: 'key-legacy',
      });
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'post_system_notification',
      expect.objectContaining({ id: 'notif-legacy' }),
    ));

    act(() => {
      show!({
        id: 'retract-legacy',
        title: '',
        body: '',
        sessionId: '',
        retract: true,
        dedupeKey: 'key-legacy',
      });
    });
    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('legacy-needed'),
      'UNUserNotificationCenter is reserved for macOS app bundles',
    ));
  });

  it('logs a distinguishable console.warn on invoke failure and on unc error result', async () => {
    retractHandler = async () => {
      throw new Error('Command retract_system_notification not allowed by ACL');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();

    act(() => {
      show!({
        id: 'notif-err-1',
        title: '有操作等你确认',
        body: '审批 1',
        sessionId: 'S2',
        urgent: true,
        dedupeKey: 'key-err-1',
      });
      show!({
        id: 'notif-err-2',
        title: '有操作等你确认',
        body: '审批 2',
        sessionId: 'S2',
        urgent: true,
        dedupeKey: 'key-err-2',
      });
    });
    await waitFor(() => expect(
      invoke.mock.calls.filter(([cmd]) => cmd === 'post_system_notification'),
    ).toHaveLength(2));

    act(() => {
      show!({
        id: 'retract-err-1',
        title: '',
        body: '',
        sessionId: '',
        retract: true,
        dedupeKey: 'key-err-1',
      });
    });
    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('retract_system_notification invoke failed'),
      'Command retract_system_notification not allowed by ACL',
    ));

    retractHandler = async () => ({
      backend: 'unc',
      ok: false,
      reason: 'UNUserNotificationCenter getDeliveredNotifications timed out',
    });
    act(() => {
      show!({
        id: 'retract-err-2',
        title: '',
        body: '',
        sessionId: '',
        retract: true,
        dedupeKey: 'key-err-2',
      });
    });
    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('retract_system_notification failed'),
      'UNUserNotificationCenter getDeliveredNotifications timed out',
    ));
  });

  it('treats unknown dedupeKey as a warn-free no-op with retractIdNotFound report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();

    act(() => {
      show!({
        id: 'retract-unknown',
        title: '',
        body: '',
        sessionId: '',
        retract: true,
        dedupeKey: 'never-seen',
      });
    });
    await flush();

    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'retract_system_notification')).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      {
        mode: 'renderer-early-return',
        reason: 'retract',
        dispatched: false,
        dedupeKey: 'never-seen',
        retractIdNotFound: true,
      },
    );
  });

  it('is a warn-free no-op in web mode', async () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    Reflect.deleteProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();

    act(() => {
      show!({
        id: 'notif-web',
        title: '有操作等你确认',
        body: '审批',
        sessionId: 'S2',
        urgent: true,
        dedupeKey: 'key-web',
      });
      show!({
        id: 'retract-web',
        title: '',
        body: '',
        sessionId: '',
        retract: true,
        dedupeKey: 'key-web',
      });
    });
    await flush();

    expect(invoke).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
