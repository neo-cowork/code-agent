import { UNATTENDED_TRUST_NOTICE } from '../../../../src/shared/unattendedTrust';
// wakeRole × 真实通知链：orchestrator 不 await onEvent，task_complete 的收口链在 run 返回之后才落地。
// 此时不能多出通用「任务完成」通知抢走角色摘要通知的预算。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const inflight = vi.hoisted(() => new Set<Promise<void>>());
const mockOrchestrator = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  cancel: vi.fn(async () => undefined),
}));
const mockLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const mockSessionManager = vi.hoisted(() => ({
  getCurrentSessionId: vi.fn(() => null),
  getSession: vi.fn(),
  createSession: vi.fn(),
  archiveSession: vi.fn(),
  updateMessage: vi.fn(),
}));
const mockRunRoleWriteBack = vi.hoisted(() => vi.fn(async () => ({ written: [], skipped: [], historyAppended: true })));
// advance→goal run（P4）：Electron 路径用落库事件读 goal 终态。
// 签名对齐真实 SessionEventService.getEventsByType(sessionId, eventType)——0 参箭头会让
// 带参 mockImplementation 撞 TS2345（tsc-tests-ratchet 2026-11-04 返修）。
const mockSessionEvents = vi.hoisted(() => ({
  getEventsByType: vi.fn((_sessionId: string, _eventType: string) => [] as Array<{ eventData?: unknown }>),
}));
const mockSessionAutomation = vi.hoisted(() => ({
  recordCreated: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

// Match production's unsupported electron alias; notificationService itself stays real.
vi.mock('../../../../src/host/platform', () => ({
  Notification: { isSupported: () => false },
  broadcastToRenderer: vi.fn(),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => mockLogger,
  logger: mockLogger,
}));

// 通用完成通知走 '../services' barrel：只取真实 notificationService + 本测试的会话管理器，避开整棵服务树。
vi.mock('../../../../src/host/services', async () => ({
  getSessionManager: () => mockSessionManager,
  notificationService: (await import('../../../../src/host/services/infra/notificationService')).notificationService,
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => mockSessionManager,
}));

// settings 可变 mock：默认空（= 出厂 silent），各测试按需 opt-in
const mockSettings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(),
    getSettings: () => mockSettings.value,
    getApiKey: () => '',
  }),
}));

vi.mock('../../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({
    provider: 'xiaomi',
    model: 'mimo-v2.5-pro',
    apiKey: 'test',
    temperature: 0.7,
    maxTokens: 4096,
  }),
}));

vi.mock('../../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => mockOrchestrator,
    setWorkingDirectory: vi.fn(),
    cleanup: vi.fn(),
    // 与 TaskManager.whenAgentEventsSettled 同语义：等在途的事件处理 promise 排空。
    whenAgentEventsSettled: async () => { while (inflight.size) await Promise.allSettled([...inflight]); },
  }),
}));

vi.mock('../../../../src/host/services/roleAssets/roleWriteBack', () => ({
  runRoleWriteBack: mockRunRoleWriteBack,
}));

vi.mock('../../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => mockSessionAutomation,
}));

vi.mock('@host/session/sessionEventService', () => ({
  getSessionEventService: () => mockSessionEvents,
}));

// agentRegistry：测试角色无 frontmatter 配置 → 走 settings / 出厂默认
vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: () => undefined,
}));
// 能力中心：默认无已连接源（外部增量段不进 prompt；带源行为见 roleWakeFindWork.test.ts）
vi.mock('../../../../src/host/services/capabilities/capabilityCenterService', () => ({
  getCapabilityCenterService: () => ({ listCapabilities: async () => ({ items: [] }) }),
}));

// hooks：RoleWake 事件 fire-and-forget，测试中不关心
vi.mock('../../../../src/host/hooks', () => ({
  createHookManager: () => ({
    initialize: vi.fn(),
    hasHooksFor: () => false,
    triggerRoleWake: vi.fn(),
  }),
}));

import { wakeRole } from '../../../../src/host/services/roleAssets/roleProactivity';
import { ensureRoleAssetDirs, appendRoleHistory } from '../../../../src/host/services/roleAssets/roleAssetService';
import { ROLE_PROACTIVITY } from '../../../../src/shared/constants';
import { notificationService } from '../../../../src/host/services/infra/notificationService';
import { settleBackgroundOnTaskComplete } from '../../../../src/host/task/backgroundTaskTerminal';
import { withWakeRunTimeout } from '../../../../src/host/services/roleAssets/wakeRunGuard';

const ROLE = '研究员';
const SESSION = 'wake-session-1';
const TODAY = new Date().toISOString().slice(0, 10);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 在 run 返回之后才收口 task_complete（生产里 onEvent 不被 await）。 */
function deliverTaskCompleteAfterRunReturns(): void {
  mockOrchestrator.sendMessage.mockImplementation(async () => {
    const handling: Promise<void> = Promise.resolve().then(() => undefined).then(() => undefined).then(() => undefined)
      .then(() => settleBackgroundOnTaskComplete(SESSION, SESSION, { summary: '检查完毕。', duration: 12000 }))
      .finally(() => { inflight.delete(handling); });
    inflight.add(handling);
  });
}

describe('wakeRole realtime notice vs late task_complete settlement', () => {
  beforeEach(async () => {
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
    notificationService.clearRecentNotifications();
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-settle-'));
    await ensureRoleAssetDirs(ROLE);
    await appendRoleHistory(ROLE, { date: TODAY, artifactLabel: '调研报告', artifactRef: '/tmp/report.md', summary: '完成初稿' });
    mockSettings.value = { roleAssets: { proactivity: { defaultLevel: 'realtime' } } };
    mockSessionManager.createSession.mockResolvedValue({ id: SESSION, workingDirectory: undefined });
    mockSessionManager.getSession.mockResolvedValue({
      id: SESSION, title: '研究员 · 主动巡检', origin: { kind: 'cron', name: ROLE_PROACTIVITY.CADENCE_JOB_TAG },
      messages: [
        { id: 'm1', role: 'user', content: 'wake prompt', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: '**检查完毕**。<decision>report</decision>', timestamp: 2 },
      ],
    });
  });
  afterEach(async () => {
    notificationService.clearRecentNotifications();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  it('task_complete settled after the run promise resolved: exactly the role summary notice, no generic notice', async () => {
    deliverTaskCompleteAfterRunReturns();
    const result = await wakeRole(ROLE, 'cadence');
    await delay(60);
    expect(result).toMatchObject({ status: 'completed', decision: 'report', sessionId: SESSION });
    expect(notificationService.getRecentNotifications()).toEqual([
      expect.objectContaining({ type: 'task_complete', sessionId: SESSION, title: `${ROLE} · ${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}`, body: '检查完毕。' }),
    ]);
  });

  it('a run that times out without task_complete does not leak the mark: later follow-up still notifies', async () => {
    const wake = { roleId: ROLE, sessionId: SESSION, phase: 'wake-run' as const, timeoutMs: 10, cancel: () => undefined };
    await expect(withWakeRunTimeout(() => new Promise<never>(() => undefined), wake)).rejects.toThrow(/timed out/);
    await settleBackgroundOnTaskComplete(SESSION, SESSION, { summary: '追问完成', duration: 3000 });
    expect(notificationService.getRecentNotifications()).toEqual([
      expect.objectContaining({ type: 'task_complete', sessionId: SESSION }),
    ]);
  });

  it('settle wait is bounded: a stuck event chain cannot keep the wake mark forever', async () => {
    vi.useFakeTimers();
    const run = withWakeRunTimeout(async () => undefined, {
      roleId: ROLE, sessionId: SESSION, phase: 'wake-run', timeoutMs: 60_000, cancel: () => undefined,
      settled: () => new Promise<void>(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(ROLE_PROACTIVITY.WAKE_EVENT_SETTLE_MAX_MS + 1);
    await run;
    vi.useRealTimers();
    await settleBackgroundOnTaskComplete(SESSION, SESSION, { summary: '追问完成', duration: 3000 });
    expect(notificationService.getRecentNotifications()).toHaveLength(1);
  });
});
