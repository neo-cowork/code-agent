// 预算窗口暂存队列落盘：退出（dispose）/ 崩溃（无 dispose）后，下次启动补发一条汇总。
// 全部走生产入口 notificationService；「重启」= resetModules 后在同一数据目录上重新 import。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '', warn: vi.fn(), info: vi.fn() }));

vi.mock('../../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer: vi.fn(),
  getUserDataPath: () => state.dir,
}));
vi.mock('../../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: state.info, warn: state.warn, error: vi.fn() }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'en' } }) }),
}));

type Svc = typeof import('../../../../src/host/services/infra/notificationService').notificationService;

async function boot(): Promise<Svc> {
  vi.resetModules();
  return (await import('../../../../src/host/services/infra/notificationService')).notificationService;
}

function complete(svc: Svc, id: string): void {
  svc.notifyTaskComplete({ sessionId: id, sessionTitle: id, duration: 1_000, toolsUsed: [] }, { force: true });
}

const heldFile = () => path.join(state.dir, 'held-notifications.json');
const loggedReasons = () => state.info.mock.calls.map((c) => (c[1] as { reason?: string } | undefined)?.reason);

describe('预算暂存队列落盘与重启补发', () => {
  beforeEach(() => {
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-notif-'));
    state.warn.mockClear();
    state.info.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    process.env.CODE_AGENT_NOTIFICATION_DRY_RUN = '1';
  });
  afterEach(() => {
    delete process.env.CODE_AGENT_NOTIFICATION_DRY_RUN;
    vi.useRealTimers();
    fs.rmSync(state.dir, { recursive: true, force: true });
  });

  it('窗口内退出（dispose）：暂存项留在磁盘，重启后补发一条汇总，且不再补发第二次', async () => {
    const first = await boot();
    complete(first, 'a'); // 开窗首条，立即投递
    complete(first, 'b');
    complete(first, 'c');
    expect(first.getRecentNotifications()).toHaveLength(1);
    expect(loggedReasons()).toContain('budget-persisted');

    await first.dispose();
    expect(fs.existsSync(heldFile())).toBe(true);
    expect(JSON.parse(fs.readFileSync(heldFile(), 'utf8')).items).toHaveLength(2);

    vi.setSystemTime(1_000_000 + 60_000);
    const second = await boot();
    second.replayPersistedHeld();
    const recent = second.getRecentNotifications();
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ type: 'digest', title: '2 more notifications' });
    expect(loggedReasons()).toContain('budget-replayed');
    const replayLog = state.info.mock.calls.find((c) => (c[1] as { reason?: string })?.reason === 'budget-replayed');
    expect(replayLog?.[1]).toMatchObject({ count: 2, oldestAgeMs: 60_000 });
    expect(fs.existsSync(heldFile())).toBe(false);

    second.replayPersistedHeld();
    expect(second.getRecentNotifications()).toHaveLength(1);
    const third = await boot();
    third.replayPersistedHeld();
    expect(third.getRecentNotifications()).toHaveLength(0);
  });

  it('崩溃（没有 dispose）：文件已在磁盘，新进程照样补发', async () => {
    const first = await boot();
    complete(first, 'a');
    complete(first, 'b');
    complete(first, 'c');
    complete(first, 'd');
    // 不 dispose：模拟 kill -9
    const second = await boot();
    second.replayPersistedHeld();
    expect(second.getRecentNotifications()[0]).toMatchObject({ type: 'digest', title: '3 more notifications' });
  });

  it('只遗留 1 条：原样投递而不是汇总', async () => {
    const first = await boot();
    complete(first, 'a');
    complete(first, 'only-held');
    await first.dispose();
    const second = await boot();
    second.replayPersistedHeld();
    expect(second.getRecentNotifications()[0]).toMatchObject({ type: 'task_complete', sessionId: 'only-held' });
  });

  it('窗口正常收尾后文件被清掉，重启不补发', async () => {
    const first = await boot();
    complete(first, 'a');
    complete(first, 'b');
    expect(fs.existsSync(heldFile())).toBe(true);
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(fs.existsSync(heldFile())).toBe(false);
    const second = await boot();
    second.replayPersistedHeld();
    expect(second.getRecentNotifications()).toHaveLength(0);
  });

  it('损坏的文件：告警并删除，不抛、不补发', async () => {
    fs.writeFileSync(heldFile(), '{not json', 'utf8');
    const svc = await boot();
    expect(() => svc.replayPersistedHeld()).not.toThrow();
    expect(svc.getRecentNotifications()).toHaveLength(0);
    expect(state.warn).toHaveBeenCalled();
    expect(fs.existsSync(heldFile())).toBe(false);
  });

  it('补发前新暂存的通知不会覆盖遗留项；clearRecentNotifications 会删文件', async () => {
    const first = await boot();
    complete(first, 'a');
    complete(first, 'b');
    await first.dispose();
    const second = await boot();
    complete(second, 'x'); // 新进程开窗首条
    complete(second, 'y'); // 暂存，落盘时须带上遗留的 b
    expect(JSON.parse(fs.readFileSync(heldFile(), 'utf8')).items).toHaveLength(2);
    second.clearRecentNotifications();
    expect(fs.existsSync(heldFile())).toBe(false);
  });
});
