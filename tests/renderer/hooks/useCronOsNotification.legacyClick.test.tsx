// @vitest-environment jsdom
// 升级前构建发出的 banner 不带 neoNotificationId：壳侧 did_receive_response 对无 id
// 通知不 emit（见 src-tauri/src/native_notification.rs），但 renderer 收到任何残缺
// payload 时必须不抛、不导航、store 原地不动，且不污染真 id 的点击去重。
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const h = vi.hoisted(() => ({
  show: null as null | ((e: unknown) => void),
  click: null as null | ((e: unknown) => void),
  unlisten: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (channel: string, cb: (e: unknown) => void) => {
      if (channel === IPC_CHANNELS.NOTIFICATION_SHOW) h.show = cb;
      return () => {};
    },
    invokeDomain: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  listenTauriEvent: vi.fn(async (_n: string, cb: (e: unknown) => void) => {
    h.click = cb;
    return h.unlisten;
  }),
}));
vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: { listParkedApprovals: vi.fn(async () => []) },
}));
vi.mock('../../../src/renderer/utils/osNotification', () => ({
  postOsNotification: vi.fn(async () => undefined),
  registerNotificationClick: vi.fn(async () => async () => {}),
}));

import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const flush = () => new Promise((r) => setTimeout(r, 20));
// 先经 NOTIFICATION_SHOW 送入一条真实完成事件：recent store / lastEvent 里有 'a'，
// 任何错误兜底（比如 routeClick(lastEvent)）都会错开它——所以每个 legacy 形状都
// 必须断言没有打开 sess-a、没有动 store。
const recent = { id: 'a', title: 'done', body: 'ok', sessionId: 'sess-a', jobId: 'job-a' };

let open: ReturnType<typeof vi.fn>;
const rejections: unknown[] = [];
const recordRejection = (err: unknown) => { rejections.push(err); };

const mountWithRecent = async () => {
  open = vi.fn();
  renderHook(() => useCronOsNotification({} as never, open as never));
  await flush();
  h.show!(recent);
  await flush();
};

const fireLegacy = async (shape: unknown) => {
  expect(() => h.click!(shape)).not.toThrow();
  await flush();
};

const expectStayedOnPage = () => {
  expect(open).not.toHaveBeenCalled();
  expect(useAppStore.getState().showCronCenter).toBe(false);
  expect(useAppStore.getState().cronCenterRunsRequested).toBe(false);
  expect(useCronStore.getState().selectedJobId).toBe(null);
  expect(useSessionStore.getState().currentSessionId).toBe('sess-current');
};

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  rejections.length = 0;
  process.on('unhandledRejection', recordRejection);
  h.click = null;
  h.unlisten.mockClear();
  useCronStore.setState({ selectedJobId: null });
  useAppStore.setState({ showCronCenter: false, cronCenterRunsRequested: false });
  useSessionStore.setState({ currentSessionId: 'sess-current' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => {
  process.removeListener('unhandledRejection', recordRejection);
  expect(rejections).toEqual([]);
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('notification-clicked legacy 形状（无 id / 空 id / 未知 id）', () => {
  it.each([
    ['事件无 payload', {}],
    ['整个事件为 null', null],
    ['payload 为 null', { payload: null }],
  ])('%s：不抛、无未处理拒绝、不开会话、store 原地不动', async (_n, shape) => {
    await mountWithRecent();
    await fireLegacy(shape);
    expectStayedOnPage();
  });

  it.each([
    ['空字符串 id', { payload: { id: '' } }],
    ['数字 id（类型不符）', { payload: { id: 42 } }],
  ])('%s：不抛、无未处理拒绝、不开会话、store 原地不动', async (_n, shape) => {
    await mountWithRecent();
    await fireLegacy(shape);
    expectStayedOnPage();
  });

  it('未知 id：不抛、不导航、warn unknown notification id，随后真 id 仍恰好开一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mountWithRecent();
    await fireLegacy({ payload: { id: 'ghost' } });
    expectStayedOnPage();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown notification id'), 'ghost');
    h.click!({ payload: { id: 'a' } });
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('sess-a');
  });

  it('legacy 点击不污染去重：全部形状打完后点真 id 仍恰好开一次 sess-a', async () => {
    await mountWithRecent();
    for (const shape of [
      {},
      null,
      { payload: null },
      { payload: { id: '' } },
      { payload: { id: 42 } },
      { payload: { id: 'ghost' } },
    ]) {
      await fireLegacy(shape);
    }
    expect(open).not.toHaveBeenCalled();
    h.click!({ payload: { id: 'a' } });
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('sess-a');
  });
});
