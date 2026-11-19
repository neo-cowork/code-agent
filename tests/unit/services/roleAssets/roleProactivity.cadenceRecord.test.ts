
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
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
  recordEvent: vi.fn(async (_event: { recordStatus?: string; configPatch?: { pendingReview?: unknown } }) => undefined),
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

const RESEARCHER = '研究员';
const TODAY = new Date().toISOString().slice(0, 10);

function primeWakeRun(decision: string, sessionId: string): void {
  mockSessionManager.createSession.mockResolvedValue({ id: sessionId, workingDirectory: undefined });
  mockSessionManager.getSession.mockResolvedValue({
    id: sessionId,
    messages: [
      { id: 'm1', role: 'user', content: 'wake prompt', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: `检查完毕。<decision>${decision}</decision>`, timestamp: 2 },
    ],
  });
  mockOrchestrator.sendMessage.mockResolvedValue(undefined);
}

describe('wakeRole → withRoleWakeAutomation 记录（N-FIX-ROLE-WAKE-CADENCE-NO-RECORD）', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-wake-record-'));
    await ensureRoleAssetDirs(RESEARCHER);
    await appendRoleHistory(RESEARCHER, { date: TODAY, artifactLabel: '调研报告', artifactRef: '/tmp/report.md', summary: '完成初稿' });
    mockSettings.value = { roleAssets: { proactivity: { defaultLevel: 'daily' } } };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  it('无来源会话的 cadence 醒来也留下一条 role_wake 记录', async () => {
    primeWakeRun('report', 'wake-cadence-1');
    await wakeRole(RESEARCHER, 'cadence');
    expect(mockSessionAutomation.recordCreated).toHaveBeenCalledTimes(1);
    expect(mockSessionAutomation.recordCreated).toHaveBeenCalledWith(expect.objectContaining({
      type: 'role_wake', sourceSessionId: null, config: expect.objectContaining({ roleId: RESEARCHER, trigger: 'cadence' }),
    }));
  });

  it('suggest → 记录落 pending_review 并带 pendingReview 标记（进待审收件箱）', async () => {
    primeWakeRun('suggest', 'wake-suggest-2');
    await wakeRole(RESEARCHER, 'cadence');
    const patch = mockSessionAutomation.recordEvent.mock.calls.at(-1)?.[0];
    expect(patch).toBeDefined();
    expect(patch?.recordStatus).toBe('pending_review');
    expect(patch?.configPatch?.pendingReview).toEqual({ resultSessionId: 'wake-suggest-2', at: expect.any(Number) });
  });

  it.each(['report', 'advance', 'silence'])('%s → 不进待审收件箱', async (decision) => {
    primeWakeRun(decision, `wake-${decision}`);
    await wakeRole(RESEARCHER, 'cadence');
    const patch = mockSessionAutomation.recordEvent.mock.calls.at(-1)?.[0];
    expect(patch).toBeDefined();
    expect(patch?.recordStatus).not.toBe('pending_review');
    expect(patch?.configPatch?.pendingReview).toBeUndefined();
  });
});
