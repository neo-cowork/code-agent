// ============================================================================
// RoleWakeFindWork Tests — 空履历 + 已连接源的「外部增量」巡检
// ① wakeRole 行为：空履历有源跑模型且 prompt 带增量段 / 无源维持静默 / 前置闸不松动 /
//    排除话题过滤提议 / 至多 2 条 / 同题去重（pending + 搁置期 dismissed）
// ② 解析容错：坏 JSON / 无围栏 / 5 条截断 / 空字段（经 storeWakeProposalsFromWake 落盘观察，
//    解析器私有，行为即契约 —— 同 roleFirstWake 先例）
// ============================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const harness = vi.hoisted(() => {
  const mockSessionManager = {
    getCurrentSessionId: vi.fn(() => null),
    getSession: vi.fn(),
    createSession: vi.fn(),
    archiveSession: vi.fn(),
    updateMessage: vi.fn(),
  };
  const mockOrchestrator = { sendMessage: vi.fn(), setExecutionTopology: vi.fn() };
  return {
    notifyRoleWakeOutput: vi.fn(),
    configDir: { dir: '' },
    mockSessionManager,
    mockOrchestrator,
    mockSessionAutomation: {
      recordCreated: vi.fn(),
      recordEvent: vi.fn(),
    },
    mockSessionEvents: { getEventsByType: vi.fn(() => []) },
    mockSettings: { value: {} as Record<string, unknown> },
    // 能力中心：默认无已连接源，各测试按需注入
    listCapabilities: vi.fn(async (): Promise<{ items: CapabilityCenterItem[] }> => ({ items: [] })),
    // 角色声明的工具（undefined = 没声明）
    declaredTools: { value: undefined as string[] | undefined },
  };
});

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => harness.configDir.dir,
  getAgentsMdDir: () => ({ user: path.join(harness.configDir.dir, 'agents') }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyRoleWakeOutput: harness.notifyRoleWakeOutput },
}));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => harness.mockSessionManager,
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => harness.mockSettings.value,
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
    getOrCreateCurrentOrchestrator: () => harness.mockOrchestrator,
    setWorkingDirectory: vi.fn(),
    cleanup: vi.fn(),
  }),
}));
vi.mock('../../../../src/host/services/roleAssets/roleWriteBack', () => ({
  runRoleWriteBack: vi.fn(async () => ({ written: [], skipped: [], historyAppended: true })),
}));
vi.mock('../../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => harness.mockSessionAutomation,
}));
vi.mock('@host/session/sessionEventService', () => ({
  getSessionEventService: () => harness.mockSessionEvents,
}));
vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: () => (harness.declaredTools.value ? { tools: harness.declaredTools.value } : undefined),
}));
vi.mock('../../../../src/host/hooks', () => ({
  createHookManager: () => ({
    initialize: vi.fn(),
    hasHooksFor: () => false,
    triggerRoleWake: vi.fn(),
  }),
}));
vi.mock('../../../../src/host/services/capabilities/capabilityCenterService', () => ({
  getCapabilityCenterService: () => ({ listCapabilities: harness.listCapabilities }),
}));

import { wakeRole } from '../../../../src/host/services/roleAssets/roleProactivity';
import { runRoleWriteBack } from '../../../../src/host/services/roleAssets/roleWriteBack';
import {
  acceptWakeProposal,
  dismissWakeProposal,
  listWakeProposals,
  storeWakeProposalsFromWake,
} from '../../../../src/host/services/roleAssets/roleWakeFindWork';
import { appendRoleHistory, ensureRoleAssetDirs, loadRoleHistory } from '../../../../src/host/services/roleAssets/roleAssetService';
import { getRoleWakeLedgerPath, getRoleWakeProposalsPath } from '../../../../src/host/services/roleAssets/roleAssetPaths';
import { ROLE_PROACTIVITY } from '../../../../src/shared/constants';
import type { CapabilityCenterItem } from '../../../../src/shared/contract/capability';

const RESEARCHER = '研究员';
const TODAY = new Date().toISOString().slice(0, 10);

/** 一个用户自连的 connector 源（判据见 roleFirstWake.isUserConnectedSource）。 */
function connectedSource(name: string): CapabilityCenterItem {
  return {
    name,
    kind: 'connector',
    state: { runtime: 'connected' },
    source: { kind: 'builtin' },
    tags: [],
  } as unknown as CapabilityCenterItem;
}

/** native 连接器源（Calendar/Mail/Reminders）：按工具名前缀与角色声明工具对齐。 */
function nativeSource(id: string, name: string): CapabilityCenterItem {
  return {
    name,
    kind: 'connector',
    state: { runtime: 'connected' },
    source: { kind: 'builtin' },
    tags: ['native', id],
  } as unknown as CapabilityCenterItem;
}

function primeNativeSources(): void {
  harness.listCapabilities.mockImplementation(async () => ({
    items: [nativeSource('calendar', 'Calendar'), nativeSource('mail', 'Mail'), nativeSource('reminders', 'Reminders')],
  }));
}

function primeConnectedSources(names: string[]): void {
  harness.listCapabilities.mockImplementation(async () => ({
    items: names.map(connectedSource),
  }));
}

/** 让 mock 会话管理器返回一次模型醒来产出。 */
function primeWakeOutput(content: string, sessionId = 'wake-findwork-1'): void {
  harness.mockSessionManager.createSession.mockResolvedValue({ id: sessionId, workingDirectory: undefined });
  harness.mockSessionManager.getSession.mockResolvedValue({
    id: sessionId,
    messages: [
      { id: 'm1', role: 'user', content: 'wake prompt', timestamp: 1 },
      { id: 'm2', role: 'assistant', content, timestamp: 2 },
    ],
  });
  harness.mockOrchestrator.sendMessage.mockResolvedValue(undefined);
}

/** 给角色预埋一条产物履历（绕过空产物守卫）。 */
async function seedProductHistory(roleId: string): Promise<void> {
  await appendRoleHistory(roleId, {
    date: TODAY,
    artifactLabel: '调研报告',
    artifactRef: '/tmp/report.md',
    summary: '完成初稿',
  });
}

async function readStoredProposals(roleId: string): Promise<{ title: string; prompt: string }[]> {
  const raw = await fs.readFile(getRoleWakeProposalsPath(roleId), 'utf-8');
  return JSON.parse(raw).proposals;
}

async function seedProposalsFile(roleId: string, state: unknown): Promise<void> {
  const filePath = getRoleWakeProposalsPath(roleId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

const PROPOSALS_FENCE = (items: unknown): string =>
  '```wake_proposals\n' + JSON.stringify(items) + '\n```';

describe('roleWakeFindWork — ① wakeRole 行为', () => {
  beforeEach(async () => {
    harness.configDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-findwork-'));
    await ensureRoleAssetDirs(RESEARCHER);
    harness.mockSettings.value = { roleAssets: { proactivity: { defaultLevel: 'daily' } } };
    vi.clearAllMocks();
    harness.declaredTools.value = undefined;
    harness.listCapabilities.mockImplementation(async () => ({ items: [] }));
  });
  afterEach(async () => {
    await fs.rm(harness.configDir.dir, { recursive: true, force: true });
  });

  function primeMail(id: number, subject: string, sessionId: string, decisionTag = '<decision>report</decision>'): void {
    harness.mockSettings.value = { roleAssets: { proactivity: { defaultLevel: 'realtime' } } };
    harness.declaredTools.value = ['mail'];
    primeNativeSources();
    primeWakeOutput(`${subject}。<rationale>合同仍待签。需要跟进。</rationale><basis>mail:${id}</basis>${decisionTag}`, sessionId);
  }

  async function rawWakeRows(): Promise<string[]> {
    return (await fs.readFile(getRoleWakeLedgerPath(RESEARCHER), 'utf8')).trim().split('\n');
  }

  it('suppresses a second cadence report about the same mail even after its subject changes', async () => {
    primeMail(401, '合同待签', 'monday-wake');
    expect(await wakeRole(RESEARCHER, 'cadence')).toMatchObject({ decision: 'report' });
    primeMail(401, '签署提醒', 'tuesday-wake');
    expect(await wakeRole(RESEARCHER, 'cadence')).toMatchObject({ decision: 'silence' });
    const raw = await rawWakeRows();
    const rows = raw.map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      decision: 'report', reason: '合同仍待签。', basisIds: ['mail:401'], trigger: 'cadence',
    });
    expect(rows[1]).toMatchObject({
      decision: 'suppressed_duplicate', reason: 'previously_reported',
      basisIds: ['mail:401'], duplicateOf: rows[0].id, firstReportedAt: rows[0].at,
    });
    expect(harness.notifyRoleWakeOutput.mock.calls.map(([notice]) => notice.sessionId)).toEqual(['monday-wake']);
    expect(harness.mockSessionManager.archiveSession.mock.calls).toEqual([['tuesday-wake']]);
    if (process.env.NEO_TEST_WAKE_LEDGER_EVIDENCE === '1') process.stdout.write(raw.join('\n') + '\n');
  });

  it('reports different mail objects that share a subject, including an event wake', async () => {
    primeMail(401, '合同待签', 'first-wake');
    await wakeRole(RESEARCHER, 'cadence');
    primeMail(402, '合同待签', 'event-wake');
    await wakeRole(RESEARCHER, 'event');
    const rows = (await rawWakeRows()).map((line) => JSON.parse(line));
    expect(rows).toMatchObject([
      { decision: 'report', basisIds: ['mail:401'], trigger: 'cadence' },
      { decision: 'report', basisIds: ['mail:402'], trigger: 'event' },
    ]);
    expect(harness.notifyRoleWakeOutput).toHaveBeenCalledTimes(2);
    expect(harness.mockSessionManager.archiveSession).not.toHaveBeenCalled();
  });

  it('still sends a fallback report with a previously reported basis', async () => {
    primeMail(401, '合同待签', 'first-wake');
    await wakeRole(RESEARCHER, 'cadence');
    primeMail(401, '合同待签', 'fallback-wake', '');
    expect(await wakeRole(RESEARCHER, 'cadence')).toMatchObject({ decision: 'report' });
    const rows = (await rawWakeRows()).map((line) => JSON.parse(line));
    expect(rows[1]).toMatchObject({ decision: 'report', basisIds: ['mail:401'], fallbackDecision: true });
    expect(harness.notifyRoleWakeOutput).toHaveBeenCalledTimes(2);
    expect(harness.mockSessionManager.archiveSession).not.toHaveBeenCalled();
  });

  it('keeps mail reports independent across workspaces', async () => {
    primeMail(401, '合同待签', 'first-wake');
    await wakeRole(RESEARCHER, 'cadence', { workspacePath: path.join(harness.configDir.dir, 'first') });
    primeMail(401, '合同待签', 'second-wake');
    await wakeRole(RESEARCHER, 'cadence', { workspacePath: path.join(harness.configDir.dir, 'second') });
    const rows = (await rawWakeRows()).map((line) => JSON.parse(line));
    expect(rows.map(({ decision }) => decision)).toEqual(['report', 'report']);
    expect(rows[0].workspaceKey).not.toBe(rows[1].workspaceKey);
  });

  it('records model silence with its stated reason and basis', async () => {
    primeWakeOutput('<decision>silence</decision><rationale>没有新进展。</rationale><basis>mail:401</basis>');
    await wakeRole(RESEARCHER, 'event');
    expect((await rawWakeRows()).map((line) => JSON.parse(line))).toMatchObject([
      { decision: 'silent', reason: '没有新进展。', basisIds: ['mail:401'] },
    ]);
  });

  it('records an excluded-topic silence distinctly', async () => {
    harness.mockSettings.value = { roleAssets: { proactivity: {
      roles: { [RESEARCHER]: { level: 'realtime', topicsExclude: ['合同'] } },
    } } };
    primeWakeOutput('合同待签。<decision>report</decision><basis>mail:401</basis>');
    await wakeRole(RESEARCHER, 'event');
    expect((await rawWakeRows()).map((line) => JSON.parse(line))).toMatchObject([
      { decision: 'silent', reason: 'excluded_topic', basisIds: ['mail:401'] },
    ]);
    expect(harness.notifyRoleWakeOutput).not.toHaveBeenCalled();
  });

  it('records a no-products silence without invoking the model', async () => {
    await wakeRole(RESEARCHER, 'cadence');
    expect((await rawWakeRows()).map((line) => JSON.parse(line))).toMatchObject([
      { decision: 'silent', reason: 'no_products', basisIds: [] },
    ]);
    expect(harness.mockOrchestrator.sendMessage).not.toHaveBeenCalled();
  });

  it('空履历 + 已连接源：模型被调用，prompt 带外部增量段（点名源与冷线索判据）', async () => {
    primeConnectedSources(['mail', 'calendar']);
    primeWakeOutput(`巡检完成，暂无要紧事。\n${PROPOSALS_FENCE([{ title: '催一下报价', prompt: '起草一封跟进报价的邮件草稿' }])}\n<decision>silence</decision>`);
    const result = await wakeRole(RESEARCHER, 'cadence');
    expect(result.status).toBe('completed');
    expect(harness.mockOrchestrator.sendMessage).toHaveBeenCalledTimes(1);
    const wakePrompt = harness.mockOrchestrator.sendMessage.mock.calls[0][0] as string;
    expect(wakePrompt).toContain('还没有经手过的产物');
    expect(wakePrompt).toContain('已连接源：mail、calendar');
    expect(wakePrompt).toContain('新邮件：上次醒来之后新收到的邮件');
    expect(wakePrompt).toContain(`超过 ${ROLE_PROACTIVITY.STALE_REPLY_DAYS} 天`);
    expect(wakePrompt).toContain('未读取');
    expect(wakePrompt).toContain('wake_proposals');
    // 提议落盘
    expect(await readStoredProposals(RESEARCHER)).toHaveLength(1);
  });

  it('每日醒来：角色只声明 calendar+mail → prompt 只列 Calendar、Mail，不含 Reminders，并带措辞规则', async () => {
    harness.declaredTools.value = ['calendar', 'mail'];
    primeNativeSources();
    primeWakeOutput('<decision>silence</decision>');
    await wakeRole(RESEARCHER, 'cadence');
    const wakePrompt = harness.mockOrchestrator.sendMessage.mock.calls[0][0] as string;
    expect(wakePrompt).toContain('已连接源：Calendar、Mail');
    expect(wakePrompt).not.toContain('Reminders');
    expect(wakePrompt).toContain('不写工具名、参数名');
    expect(wakePrompt).toContain('未读取：<源名>」，后面跟一句通俗的原因');
  });

  it('每日醒来：角色另外声明 reminders → 仍列 Reminders', async () => {
    harness.declaredTools.value = ['calendar', 'mail', 'reminders'];
    primeNativeSources();
    primeWakeOutput('<decision>silence</decision>');
    await wakeRole(RESEARCHER, 'cadence');
    const wakePrompt = harness.mockOrchestrator.sendMessage.mock.calls[0][0] as string;
    expect(wakePrompt).toContain('已连接源：Calendar、Mail、Reminders');
  });

  it('每日醒来：角色没声明工具 → 维持旧行为，列全部已连接源', async () => {
    primeNativeSources();
    primeWakeOutput('<decision>silence</decision>');
    await wakeRole(RESEARCHER, 'cadence');
    const wakePrompt = harness.mockOrchestrator.sendMessage.mock.calls[0][0] as string;
    expect(wakePrompt).toContain('已连接源：Calendar、Mail、Reminders');
  });

  it('强制失败：声明 calendar+mail 的角色两源都「未读取」+ 模型选沉默 → 仍纠正为 report', async () => {
    harness.declaredTools.value = ['calendar', 'mail'];
    primeNativeSources();
    primeWakeOutput('未读取：Calendar（日历暂时打不开）\n未读取：Mail（邮箱暂时连不上）\n<decision>silence</decision>');
    const result = await wakeRole(RESEARCHER, 'cadence');
    expect(result.decision).toBe('report');
  });

  it('空履历 + 无已连接源：维持既有静默，不烧模型 token', async () => {
    primeWakeOutput('不应被调用');
    const result = await wakeRole(RESEARCHER, 'cadence');
    expect(result.status).toBe('completed');
    expect(result.decision).toBe('silence');
    expect(harness.mockOrchestrator.sendMessage).not.toHaveBeenCalled();
    const history = await loadRoleHistory(RESEARCHER, 100);
    expect(history.some((l) => l.includes('履历中没有产物'))).toBe(true);
  });

  it('前置闸不松动：silent 档（有源也跳过）', async () => {
    primeConnectedSources(['mail']);
    harness.mockSettings.value = {};
    const result = await wakeRole(RESEARCHER, 'cadence');
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('silent_level');
    expect(harness.mockOrchestrator.sendMessage).not.toHaveBeenCalled();
  });

  it('前置闸不松动：日预算 4 次（有源也跳过）', async () => {
    primeConnectedSources(['mail']);
    for (let i = 0; i < ROLE_PROACTIVITY.MAX_WAKES_PER_DAY; i++) {
      await appendRoleHistory(RESEARCHER, {
        date: TODAY,
        artifactLabel: `${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}（cadence）`,
        artifactRef: '-',
        summary: `第 ${i + 1} 次醒来`,
      });
    }
    const result = await wakeRole(RESEARCHER, 'cadence');
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe(`daily_budget_exceeded (${ROLE_PROACTIVITY.MAX_WAKES_PER_DAY}/${ROLE_PROACTIVITY.MAX_WAKES_PER_DAY})`);
    expect(harness.mockOrchestrator.sendMessage).not.toHaveBeenCalled();
  });

  it('前置闸不松动：免打扰时段（有源也跳过）', async () => {
    primeConnectedSources(['mail']);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(`${TODAY}T02:30:00`));
      harness.mockSettings.value = {
        roleAssets: { proactivity: { roles: { [RESEARCHER]: { level: 'daily', quietHours: { start: '23:00', end: '08:00' } } } } },
      };
      const result = await wakeRole(RESEARCHER, 'cadence');
      expect(result.status).toBe('skipped');
      expect(result.skipReason).toBe('quiet_hours');
      expect(harness.mockOrchestrator.sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('履历有产物 + 有源：prompt 同样带增量段（并行巡检口径）', async () => {
    await seedProductHistory(RESEARCHER);
    primeConnectedSources(['calendar']);
    primeWakeOutput('检查完毕。<decision>report</decision>');
    await wakeRole(RESEARCHER, 'cadence');
    const wakePrompt = harness.mockOrchestrator.sendMessage.mock.calls[0][0] as string;
    expect(wakePrompt).toContain('外部数据源巡检');
    expect(wakePrompt).toContain('与产物巡检并行');
    expect(wakePrompt).toContain('出现 TODO'); // 基础四选一段原样保留
  });

  it('排除话题命中 → 该提议被丢弃，其余保留', async () => {
    primeConnectedSources(['mail']);
    harness.mockSettings.value = {
      roleAssets: { proactivity: { roles: { [RESEARCHER]: { level: 'daily', topicsExclude: ['股票'] } } } },
    };
    primeWakeOutput(`巡检完成。\n${PROPOSALS_FENCE([
      { title: '复盘股票持仓', prompt: '起草股票复盘草稿' },
      { title: '催一下报价', prompt: '起草跟进报价的邮件草稿' },
    ])}\n<decision>report</decision>`);
    await wakeRole(RESEARCHER, 'cadence');
    const stored = await readStoredProposals(RESEARCHER);
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('催一下报价');
  });

  it('全源「未读取」+ 模型选沉默 → 纠正为 report（点名故障，不许静默）', async () => {
    primeConnectedSources(['mail']);
    primeWakeOutput('mail 读取失败。未读取：mail\n<decision>silence</decision>');
    const result = await wakeRole(RESEARCHER, 'cadence');
    expect(result.decision).toBe('report');
  });

  it('排除话题命中且全源未读取：保持 silence，不改回 report（不归档失败、不写回记忆、履历不落原文）', async () => {
    primeConnectedSources(['mail', 'calendar']);
    harness.mockSettings.value = {
      roleAssets: {
        proactivity: {
          roles: {
            [RESEARCHER]: { level: 'realtime', topicsExclude: ['八卦'] },
          },
        },
      },
    };
    primeWakeOutput(
      '办公室八卦还没回。未读取：mail\n未读取：calendar\n<decision>suggest</decision>',
      'wake-exclude-unread',
    );
    const result = await wakeRole(RESEARCHER, 'cadence');
    expect(result.decision).toBe('silence');
    expect(harness.mockSessionManager.archiveSession).toHaveBeenCalledWith('wake-exclude-unread');
    expect(vi.mocked(runRoleWriteBack)).not.toHaveBeenCalled();
    expect(harness.mockSessionManager.updateMessage).not.toHaveBeenCalled();
    const history = await loadRoleHistory(RESEARCHER, 100);
    expect(history.some((line) => line.includes('命中排除话题，已停止汇报'))).toBe(true);
    expect(history.some((line) => line.includes('八卦'))).toBe(false);
    expect(history.some((line) => line.includes('[report]'))).toBe(false);
    expect(history.some((line) => line.includes('[suggest]'))).toBe(false);
  });

  it('IPC 面：list / accept（返回 prompt 并移除）/ dismiss（移入 dismissed）', async () => {
    await seedProposalsFile(RESEARCHER, {
      proposals: [{ title: '改期 14:00 会议', prompt: '拟一封改期邮件草稿', createdAt: '2026-10-26T01:00:00.000Z' }],
      dismissed: [],
    });
    expect(await listWakeProposals(RESEARCHER)).toHaveLength(1);
    const accepted = await acceptWakeProposal(RESEARCHER, '改期 14:00 会议');
    expect(accepted?.prompt).toBe('拟一封改期邮件草稿');
    expect(await listWakeProposals(RESEARCHER)).toHaveLength(0);
    // 重新播种再 dismiss
    await seedProposalsFile(RESEARCHER, {
      proposals: [{ title: '催报价', prompt: 'x', createdAt: '2026-10-26T01:00:00.000Z' }],
      dismissed: [],
    });
    expect(await dismissWakeProposal(RESEARCHER, '催报价')).toEqual({ success: true });
    expect(await listWakeProposals(RESEARCHER)).toHaveLength(0);
    const state = JSON.parse(await fs.readFile(getRoleWakeProposalsPath(RESEARCHER), 'utf-8'));
    expect(state.dismissed[0].title).toBe('催报价');
  });

  it('同题去重：pending 同题不再入库；dismissed 搁置期内同题不再入库', async () => {
    // pending 同题
    await seedProposalsFile(RESEARCHER, {
      proposals: [{ title: '催一下报价', prompt: '旧', createdAt: '2026-10-25T01:00:00.000Z' }],
      dismissed: [],
    });
    const stored1 = await storeWakeProposalsFromWake({
      roleId: RESEARCHER,
      finalOutput: PROPOSALS_FENCE([
        { title: '催一下报价', prompt: '新' },
        { title: '改期 14:00 会议', prompt: '拟改期邮件' },
      ]),
    });
    expect(stored1).toBe(1);
    expect((await readStoredProposals(RESEARCHER)).map((p) => p.title)).toEqual(['催一下报价', '改期 14:00 会议']);
    // dismissed 搁置期内同题
    await seedProposalsFile(RESEARCHER, {
      proposals: [],
      dismissed: [{ title: '催一下报价', dismissedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }],
    });
    const stored2 = await storeWakeProposalsFromWake({
      roleId: RESEARCHER,
      finalOutput: PROPOSALS_FENCE([{ title: '催一下报价', prompt: '又来了' }]),
    });
    expect(stored2).toBe(0);
    expect(await readStoredProposals(RESEARCHER)).toHaveLength(0);
  });
});

describe('roleWakeFindWork — ② 解析容错（经落盘观察）', () => {
  beforeEach(async () => {
    harness.configDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-findwork-2-'));
    await ensureRoleAssetDirs(RESEARCHER);
  });
  afterEach(async () => {
    await fs.rm(harness.configDir.dir, { recursive: true, force: true });
  });

  it('坏 JSON → 不落盘也不炸', async () => {
    const stored = await storeWakeProposalsFromWake({
      roleId: RESEARCHER,
      finalOutput: '```wake_proposals\n[{broken json\n```',
    });
    expect(stored).toBe(0);
    await expect(fs.readFile(getRoleWakeProposalsPath(RESEARCHER), 'utf-8')).rejects.toThrow();
  });

  it('无围栏 → 0', async () => {
    const stored = await storeWakeProposalsFromWake({
      roleId: RESEARCHER,
      finalOutput: '没有提议块。\n<decision>silence</decision>',
    });
    expect(stored).toBe(0);
  });

  it('5 条 → 截到 MAX_PROPOSALS=2', async () => {
    const stored = await storeWakeProposalsFromWake({
      roleId: RESEARCHER,
      finalOutput: PROPOSALS_FENCE([1, 2, 3, 4, 5].map((i) => ({ title: `提议${i}`, prompt: `委托${i}` }))),
    });
    expect(stored).toBe(ROLE_PROACTIVITY.MAX_PROPOSALS);
    expect(await readStoredProposals(RESEARCHER)).toHaveLength(2);
  });

  it('空 title / 空 prompt → 丢弃，合法项保留', async () => {
    const stored = await storeWakeProposalsFromWake({
      roleId: RESEARCHER,
      finalOutput: PROPOSALS_FENCE([
        { title: '', prompt: '有 prompt 没 title' },
        { title: '只有标题', prompt: '   ' },
        { title: '合法提议', prompt: '起草草稿' },
      ]),
    });
    expect(stored).toBe(1);
    expect((await readStoredProposals(RESEARCHER))[0].title).toBe('合法提议');
  });
});
