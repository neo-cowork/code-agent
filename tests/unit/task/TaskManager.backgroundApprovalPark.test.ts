// 后台任务审批：页面关闭时停车进收件箱，不再 60s 自动拒绝。
// 走生产入口：TaskManager.startBackgroundTask / getOrCreateOrchestrator → 真 AgentOrchestrator → 真岛 requestPermission。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ApprovalRow = { id: string; kind: string; payload: Record<string, unknown> };
type ApprovalStatus = 'pending' | 'approved' | 'rejected';

const h = vi.hoisted(() => ({
  ui: true,
  rows: new Map<string, ApprovalRow & { status: ApprovalStatus }>(),
}));

const fakeRepo = {
  insert: vi.fn((row: ApprovalRow) => { h.rows.set(row.id, { ...row, status: 'pending' }); }),
  resolve: ({ id, status }: { id: string; status: 'approved' | 'rejected' }) => {
    const row = h.rows.get(id);
    if (row?.status !== 'pending') return 0;
    row.status = status;
    return 1;
  },
};

vi.mock('../../../src/host/platform', async (orig) => ({
  ...(await orig<typeof import('../../../src/host/platform')>()),
  hasInteractiveUi: () => h.ui,
  broadcastToRenderer: vi.fn(),
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    isReady: true,
    updateSession: vi.fn(),
    getSession: () => null,
    getPendingApprovalRepo: () => fakeRepo,
  }),
}));
vi.mock('../../../src/host/task/backgroundTaskSessionContext', () => ({
  getBackgroundTaskSessionContext: async () => null,
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn(), retractNeedsInput: vi.fn() },
}));

import { TaskManager } from '../../../src/host/task/TaskManager';
import { AgentOrchestrator } from '../../../src/host/agent/agentOrchestrator';
import { approvalParkEvents } from '../../../src/host/agent/approvalParkEvents';
import { getPermissionModeManager } from '../../../src/host/permissions/modes';

type Asked = { orch?: AgentOrchestrator; result?: { approved: boolean; denialSource?: string }; settled: boolean };

/** 让真 orchestrator 的 sendMessage 通过它自己的岛发起一次非 forceConfirm 的 Bash 审批。 */
function stubSend(asked: Asked): void {
  vi.spyOn(AgentOrchestrator.prototype, 'sendMessage').mockImplementation(async function (this: AgentOrchestrator) {
    asked.orch = this;
    const island = (this as unknown as { permissions: { requestPermission: (r: unknown) => Promise<Asked['result']>; injectedPendingApprovalRepo?: unknown } }).permissions;
    // 生产里岛用 require('databaseService') 懒取库（绕过 vi.mock），这里只替换仓库，岛和 probe 仍是 TaskManager 接好的真对象。
    island.injectedPendingApprovalRepo = fakeRepo;
    const pending = island.requestPermission({
      type: 'command', tool: 'Bash', sessionId: sessionIdOf(this),
      details: { command: 'ls /usr/local/bin' }, parentToolUseId: 'tu-1',
    });
    void pending.then((r) => { asked.result = r; asked.settled = true; });
  } as never);
}
function sessionIdOf(o: AgentOrchestrator): string {
  return (o as unknown as { sessionId: string }).sessionId;
}

function makeManager(): TaskManager {
  const m = new TaskManager({ maxConcurrentTasks: 2 });
  m.initialize({
    configService: {
      getSettings: () => ({ permissions: { autoApprove: {} }, ui: { language: 'zh' } }),
      isDevModeAutoApproveEnabled: () => false,
    } as never,
    onAgentEvent: vi.fn(),
  });
  return m;
}

describe('background task approval when nobody is on the page', () => {
  beforeEach(() => { vi.useFakeTimers(); fakeRepo.insert.mockClear(); h.rows.clear(); h.ui = true; });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function runBackground(sessionId: string): Promise<Asked> {
    const asked: Asked = { settled: false };
    stubSend(asked);
    void makeManager().startBackgroundTask(`task-${sessionId}`, sessionId, 'weekly report');
    await vi.advanceTimersByTimeAsync(10);
    return asked;
  }

  it('no UI: parks a pending_approvals row and never times out after 60s+', async () => {
    h.ui = false;
    const asked = await runBackground('s-bg-noui');
    await vi.advanceTimersByTimeAsync(90_000);
    expect([...h.rows.values()]).toMatchObject([{ payload: { tool: 'Bash' }, status: 'pending' }]);
    expect(asked.settled).toBe(false);
    expect(asked.result?.denialSource).not.toBe('timeout');
  });

  it('UI present: card waits inline with one pending mirror and settles it on allow', async () => {
    const parkEvents = vi.spyOn(approvalParkEvents, 'emit');
    const asked = await runBackground('s-bg-ui');
    await vi.advanceTimersByTimeAsync(90_000);
    expect([...h.rows.values()]).toMatchObject([{
      kind: 'tool_approval',
      status: 'pending',
      payload: { argsRef: { sessionId: 's-bg-ui', toolCallId: 'tu-1' }, backgroundLane: true },
    }]);
    expect(fakeRepo.insert).toHaveBeenCalledTimes(1);
    expect(asked.settled).toBe(false);
    const [id] = h.rows.keys();
    expect(asked.orch?.handlePermissionResponse(id, 'allow')).toBe('delivered');
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.result).toMatchObject({ approved: true });
    expect([...h.rows.values()]).toMatchObject([{ id, status: 'approved' }]);
    expect(parkEvents).not.toHaveBeenCalled();
  });

  it('page closes after the card showed: watchdog moves the same request into the inbox', async () => {
    const parkEvents = vi.spyOn(approvalParkEvents, 'emit');
    const asked = await runBackground('s-bg-late');
    await vi.advanceTimersByTimeAsync(20_000);
    expect([...h.rows.values()]).toMatchObject([{ status: 'pending' }]);
    const [id] = h.rows.keys();
    expect(fakeRepo.insert).toHaveBeenCalledTimes(1);
    expect(parkEvents).not.toHaveBeenCalled();
    h.ui = false;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fakeRepo.insert).toHaveBeenCalledTimes(2);
    expect(fakeRepo.insert).toHaveBeenNthCalledWith(2, expect.objectContaining({ id }));
    expect([...h.rows.values()]).toMatchObject([{ id, status: 'pending' }]);
    expect(parkEvents).toHaveBeenCalledExactlyOnceWith('parked', expect.objectContaining({ id }));
    expect(asked.settled).toBe(false);
  });

  it.each([
    ['cron-style unattended (backstop)', 'markUnattendedSession'],
    ['voice', 'markLiveVoice'],
    ['approval terminal (60s legacy)', 'markUnattendedApprovalTerminal'],
  ])('%s background lane keeps its own mode: probe stays false', async (_n, how) => {
    h.ui = false;
    const sid = `s-bg-${how}`;
    const pm = getPermissionModeManager();
    if (how === 'markLiveVoice') (pm as unknown as { liveVoiceHolds: Map<string, Set<string>> }).liveVoiceHolds.set(sid, new Set(['x']));
    else (pm as unknown as Record<string, (s: string) => void>)[how](sid);
    const m = makeManager();
    const asked: Asked = { settled: false };
    stubSend(asked);
    void m.startBackgroundTask(`task-${sid}`, sid, 'x');
    await vi.advanceTimersByTimeAsync(10);
    const detachedProbe = (asked.orch as unknown as { permissions: { isDetachedRun: () => boolean } }).permissions.isDetachedRun;
    expect(detachedProbe()).toBe(false);
    // 各自原有的停车/回退路径不变：unattended 与语音仍停车（行数 1），60s 终态会话不停车。
    if (how === 'markUnattendedApprovalTerminal') {
      await vi.advanceTimersByTimeAsync(90_000);
      expect(h.rows.size).toBe(0);
      expect(fakeRepo.insert).not.toHaveBeenCalled();
      expect(asked.result?.denialSource).toBe('timeout');
    } else {
      expect([...h.rows.values()]).toMatchObject([{ status: 'pending' }]);
    }
  });

  it('session orchestrator (non-background) keeps old behaviour: probe false even with no UI', () => {
    h.ui = false;
    const m = makeManager();
    const wrapper = (m as unknown as { getOrCreateOrchestrator: (s: string) => { orchestrator: unknown } }).getOrCreateOrchestrator('s-main');
    const probe = (wrapper.orchestrator as unknown as { permissions: { isDetachedRun: () => boolean } }).permissions.isDetachedRun;
    expect(probe()).toBe(false);
  });
});
