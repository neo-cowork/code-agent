// @vitest-environment jsdom
/**
 * 链路测试：壳退出后无人值守 tool_approval 停车 → 原生横幅 notify-only argv →
 * 壳 notification-clicked 载荷 → 真实 useCronOsNotification（冷启动）→ 落点。
 * 全程走生产入口：OrchestratorPermissionIsland.requestPermission、真实文件 SQLite 上的
 * PendingApprovalRepository、真实 NotificationService、真实 SessionAutomationService.listParkedApprovals。
 * 证据档位：hermetic-protocol（不含真壳；点击载荷由下方 TS 镜像构造）。
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const h = vi.hoisted(() => ({
  broadcast: vi.fn(),
  click: null as null | ((e: { payload: { id: string; sessionId?: string } }) => void),
  repo: null as PendingApprovalRepository | null,
}));

vi.mock('../../../src/host/platform', async () => ({
  ...await import('../../../src/host/platform/notifications'),
  broadcastToRenderer: h.broadcast,
}));
vi.mock('../../../src/host/services/serviceRegistry', () => ({ getServiceRegistry: () => ({ register: vi.fn() }) }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));
vi.mock('../../../src/host/services/infra/notificationHeldStore', () => ({ readHeldFile: () => [], writeHeldFile: vi.fn() }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getPendingApprovalRepo: () => h.repo, getSession: () => undefined, getRecentMessages: () => [] }),
}));

// 渲染端：只替换壳/IPC 边界；listParkedApprovals 委托给真实 SessionAutomationService。
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { on: vi.fn(() => () => {}), invokeDomain: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  listenTauriEvent: vi.fn(async (_n: string, cb: (e: { payload: { id: string; sessionId?: string } }) => void) => {
    h.click = cb;
    return () => {};
  }),
}));
vi.mock('../../../src/renderer/services/sessionAutomationClient', async () => {
  const { SessionAutomationService } = await import('../../../src/host/services/sessionAutomation/sessionAutomationService');
  return { sessionAutomationClient: { listParkedApprovals: vi.fn(async () => new SessionAutomationService().listParkedApprovals()) } };
});
vi.mock('../../../src/renderer/utils/osNotification', () => ({
  postOsNotification: vi.fn(async () => undefined),
  registerNotificationClick: vi.fn(async () => async () => {}),
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { sessionAutomationClient } from '../../../src/renderer/services/sessionAutomationClient';
import ipcService from '../../../src/renderer/services/ipcService';
import { listenTauriEvent } from '../../../src/renderer/services/tauriPluginFacade';
import { postOsNotification } from '../../../src/renderer/utils/osNotification';
import { getDaemonQuitIntent, setDaemonQuitIntent } from '../../../src/host/services/daemon/quitIntent';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { notificationService } from '../../../src/host/services/infra/notificationService';
import { NEEDS_INPUT_NATIVE_FALLBACK } from '../../../src/shared/constants/timeouts';
import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';
import { useAppStore } from '../../../src/renderer/stores/appStore';

/** TS mirror of `clicked_payload(id, session_id)` in src-tauri/src/native_notification.rs. */
function clickedPayload(id: string, sessionId?: string): { id: string; sessionId?: string } {
  const payload: { id: string; sessionId?: string } = { id };
  if (sessionId) payload.sessionId = sessionId;
  return payload;
}

function argvValue(argv: string[], flag: string): string {
  expect(argv).toContain(flag);
  const value = argv[argv.indexOf(flag) + 1];
  expect(value).toBeTruthy();
  return value;
}

const initialAppState = useAppStore.getState();

describe('parked approval banner click → route (chain)', () => {
  let dir: string;
  let db: BetterSqlite3.Database;
  let repo: PendingApprovalRepository;
  let island: OrchestratorPermissionIsland;
  let argvDir: string;
  let raises: Array<ReturnType<OrchestratorPermissionIsland['requestPermission']>>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.clearAllMocks();
    resetPermissionModeManager();
    raises = [];
    setDaemonQuitIntent('background');
    expect(getDaemonQuitIntent()).toBe('background');
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'parked-banner-chain-')));
    db = new Database(path.join(dir, 'test.db'));
    db.pragma('foreign_keys = ON');
    applySchema(db, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never);
    repo = new PendingApprovalRepository(db);
    h.repo = repo;
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '');
    // 真实 spawn（生产 sendNativeNotification）拉起的是一个只记录 argv 的假壳，不会碰已安装的 Agent Neo。
    argvDir = path.join(dir, 'argv');
    mkdirSync(argvDir);
    const fakeShell = path.join(dir, 'fake-shell.sh');
    writeFileSync(fakeShell, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvDir}/argv-$$.txt"\n`);
    chmodSync(fakeShell, 0o755);
    vi.stubEnv('CODE_AGENT_SHELL_EXE', fakeShell);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    notificationService.clearRecentNotifications();
    notificationService.setNativeNotificationSender(null);
    notificationService.setNotificationSessionTitleResolver(async () => '会议纪要');
    island = new OrchestratorPermissionIsland({
      getSettings: () => ({ permissions: { autoApprove: {} } }) as never,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      onEvent: () => {},
      injectedPendingApprovalRepo: repo,
    });
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    h.click = null;
    useAppStore.setState(initialAppState, true);
    useAppStore.getState().setShowActivityPanel(true);
    useAppStore.getState().clearCronCenterRunsRequest();
  });

  afterEach(async () => {
    cleanup();
    island.drainPendingPermissions();
    await Promise.all(raises);
    expect(island.listPendingRequests()).toEqual([]);
    notificationService.clearRecentNotifications();
    notificationService.setNotificationSessionTitleResolver(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetPermissionModeManager();
    setDaemonQuitIntent('stop');
    useAppStore.setState(initialAppState, true);
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 经 requestPermission 停车一条无人值守 tool_approval，返回壳点击载荷与 notify-only argv。 */
  async function raise(sessionId: string) {
    getPermissionModeManager().markUnattendedSession(sessionId);
    raises.push(island.requestPermission({
      type: 'command',
      tool: 'bash',
      sessionId,
      forceConfirm: true,
      reason: 'needs confirm',
      details: { command: 'echo hi' },
    }));
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    vi.useRealTimers();
    const readArgvs = () => readdirSync(argvDir).map((f) => readFileSync(path.join(argvDir, f), 'utf8').split('\n').slice(0, -1));
    let argv: string[] | undefined;
    await waitFor(() => {
      argv = readArgvs().find((a) => a.includes('--session') && argvValue(a, '--session') === sessionId);
      expect(argv, `notify-only argv for ${sessionId}`).toBeDefined();
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const event = h.broadcast.mock.calls.find(([channel, data]) => channel === IPC_CHANNELS.NOTIFICATION_SHOW && data.sessionId === sessionId)?.[1];
    const request = island.listPendingRequests().find((item) => item.sessionId === sessionId)!;
    const row = repo.getById(request.id);
    expect(row).toMatchObject({ kind: 'tool_approval', coordinatorId: sessionId, status: 'pending' });
    expect(JSON.parse(row!.payloadJson)).toMatchObject({ sessionId });
    expect(event).toMatchObject({ id: argvValue(argv!, '--id'), sessionId, dedupeKey: row!.id });
    expect(argv![0]).toBe('--notify-only');
    console.info('CAPTURED notify-only argv:', JSON.stringify(argv));
    return { argv: argv!, payload: clickedPayload(argvValue(argv!, '--id'), argvValue(argv!, '--session')) };
  }

  /** 冷启动：从未见过 NOTIFICATION_SHOW，id 未知；点击只靠壳载荷里的 sessionId。 */
  async function coldClick(payload: { id: string; sessionId?: string }) {
    vi.useRealTimers();
    const open = vi.fn();
    const runs = vi.spyOn(useAppStore.getState(), 'openCronCenterRuns');
    renderHook(() => useCronOsNotification({} as never, open));
    await waitFor(() => expect(h.click).not.toBeNull());
    expect(listenTauriEvent).toHaveBeenCalledExactlyOnceWith('notification-clicked', expect.any(Function));
    expect(ipcService.on).toHaveBeenCalledWith(IPC_CHANNELS.NOTIFICATION_SHOW, expect.any(Function));
    // The host broadcast was captured, never delivered to this newly mounted renderer.
    expect(postOsNotification).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({ showActivityPanel: true, showCronCenter: false, cronCenterRunsRequested: false });
    expect(runs).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(sessionAutomationClient.listParkedApprovals).not.toHaveBeenCalled();
    await act(async () => { h.click!({ payload }); });
    await waitFor(() => expect(runs.mock.calls.length + open.mock.calls.length).toBe(1));
    expect(sessionAutomationClient.listParkedApprovals).toHaveBeenCalledOnce();
    const items = await vi.mocked(sessionAutomationClient.listParkedApprovals).mock.results[0].value;
    console.info('CLICK payload / real inbox:', JSON.stringify({ payload, items }));
    const record = {
      openCronCenterRuns: useAppStore.getState().cronCenterRunsRequested,
      showCronCenter: useAppStore.getState().showCronCenter,
      onOpenSession: open.mock.calls.map((c) => c[0]),
    };
    console.info('ROUTE record:', JSON.stringify({ ...record, openCronCenterRunsCalls: runs.mock.calls, restoredActivityPage: useAppStore.getState().showActivityPanel }));
    return { record, items };
  }

  it('banner argv 带该审批的 sessionId，且行是真实 pending', async () => {
    const { argv, payload } = await raise('sess-A');
    expect(argvValue(argv, '--session')).toBe('sess-A');
    expect(payload).toEqual({ id: argvValue(argv, '--id'), sessionId: 'sess-A' });
    const rows = repo.listByKindAndStatus('tool_approval', 'pending');
    expect(rows.map((r) => r.coordinatorId)).toEqual(['sess-A']);
  });

  it('pending 行 → 冷启动点击落「自动化 → 运行记录」，不开会话', async () => {
    const { payload } = await raise('sess-A');
    const { record, items } = await coldClick(payload);
    expect(items).toEqual([expect.objectContaining({ id: repo.listByKindAndStatus('tool_approval', 'pending')[0].id, sessionId: 'sess-A', status: 'pending' })]);
    expect(useAppStore.getState().showActivityPanel).toBe(false);
    expect(record).toEqual({ openCronCenterRuns: true, showCronCenter: true, onOpenSession: [] });
  });

  it.each(['orphaned', 'rejected', 'rejected-voided'] as const)('点击时行已是 %s → 开会话', async (status) => {
    const { payload } = await raise('sess-A');
    const [row] = repo.listByKindAndStatus('tool_approval', 'pending');
    if (status === 'orphaned') repo.markPendingAsOrphaned('tool_approval', Date.now());
    else repo.resolve({ id: row.id, status: 'rejected', feedback: status === 'rejected-voided' ? 'Auto-rejected after restart: args_unavailable' : 'no', resolvedAt: Date.now() });
    expect(repo.getById(row.id)?.status).toBe(status === 'orphaned' ? 'orphaned' : 'rejected');
    const { record, items } = await coldClick(payload);
    if (status === 'rejected') expect(items).toEqual([]);
    else expect(items).toEqual([expect.objectContaining({ id: row.id, sessionId: 'sess-A', status: status === 'orphaned' ? 'orphaned' : 'voided' })]);
    expect(record).toEqual({ openCronCenterRuns: false, showCronCenter: false, onOpenSession: ['sess-A'] });
  });

  it('只有别的会话还 pending → 开被点击会话', async () => {
    const a = await raise('sess-A');
    await raise('sess-B');
    const rowA = repo.listByKindAndStatus('tool_approval', 'pending').find((r) => r.coordinatorId === 'sess-A')!;
    repo.resolve({ id: rowA.id, status: 'rejected', feedback: 'no', resolvedAt: Date.now() });
    expect(repo.listByKindAndStatus('tool_approval', 'pending').map((r) => r.coordinatorId)).toEqual(['sess-B']);
    const { record, items } = await coldClick(a.payload);
    expect(items).toEqual([expect.objectContaining({ sessionId: 'sess-B', status: 'pending' })]);
    expect(record).toEqual({ openCronCenterRuns: false, showCronCenter: false, onOpenSession: ['sess-A'] });
  });
});
