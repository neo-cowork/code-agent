// N-CONNECTOR-POLISH-AUDIT-FU4-LOSTCARD ⑥：无人值守 cron 运行遇到连接器登录丢失 → 待过目收件箱
// 同连接器同本地日历日至多一条。真 executeCronAgentAction + 真 SessionAutomationService + 文件型 SQLite；
// 只有会话创建与 orchestrator 被脚本化。时钟用 fake Date 注入。
import fs from 'node:fs';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const state = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
  messages: [] as Array<{ id: string }>,
  orchestratorMessages: [] as unknown[],
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => state.db }),
}));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    // 与真 sessionManager 一致：消息 id 幂等
    addMessageToSession: async (_sessionId: string, message: { id: string }) => {
      if (!state.messages.some((m) => m.id === message.id)) state.messages.push(message);
    },
  }),
}));
vi.mock('../../../src/host/cron/cronAgentSession', () => ({
  createCronAgentSession: async (_def: unknown, _action: unknown, executionId?: string) => ({
    id: `session-of-${executionId}`, workingDirectory: undefined,
  }),
}));
vi.mock('../../../src/host/cron/cronAgentRoleContext', () => ({ buildCronAgentRunOptions: async () => ({}) }));
vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => ({
      setExecutionTopology: vi.fn(),
      sendMessage: async () => undefined,
      getMessages: () => state.orchestratorMessages,
    }),
    setWorkingDirectory: vi.fn(),
    cleanup: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: (roleId: string) => (roleId === 'feishu-expert' ? { connectors: [{ id: 'feishu', level: 'core' }] } : undefined),
}));

import { replaceCliConnectorConnectionStatusCache } from '../../../src/host/connectors/cli/cliConnectorStatusCache';
import { executeCronAgentAction } from '../../../src/host/cron/cronAgentAction';
import { getSessionAutomationService } from '../../../src/host/services/sessionAutomation';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

const EVIDENCE = process.env.FU4_RAW_OUT ?? '/dev/null';
let dir: string;

const job = {
  id: 'job-1',
  name: '每日读飞书',
  scheduleType: 'every',
  schedule: { type: 'every', interval: 24, unit: 'hours' },
  action: { type: 'agent', agentType: 'default', prompt: '读我最新的 Notion 页面并总结' },
  enabled: true,
} as unknown as CronJobDefinition;
const host = {
  loadJob: () => job,
  updateJob: async () => undefined,
  deliverCronResult: async () => undefined,
  recordSessionId: async () => undefined,
};

const unauthorizedRun = [{
  role: 'tool',
  toolResults: [{ toolCallId: 't1', success: false, error: 'Unauthorized', metadata: { mcpAuthorizationRequired: true, server: 'notion' } }],
}];

function automationRows() {
  return state.db!.prepare('SELECT id, type, status, title, config_json FROM session_automations').all()
    .map((row) => ({ ...(row as Record<string, unknown>), config_json: JSON.parse(String((row as { config_json: string }).config_json)) }));
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cron-connector-lost-')));
  state.db = new Database(path.join(dir, 'cron.db'));
  state.db.exec(`CREATE TABLE session_automations (
    id TEXT PRIMARY KEY, source_session_id TEXT, type TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
    cadence_label TEXT, next_run_at INTEGER, last_run_at INTEGER, source_ref_id TEXT, result_session_id TEXT,
    config_json TEXT DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  state.messages = [];
  state.orchestratorMessages = unauthorizedRun;
  await getSessionAutomationService().recordCreated({
    id: 'cron:job-1', sourceSessionId: 'src-session', type: 'cron', status: 'active', title: '每日读飞书', sourceRefId: 'job-1',
  });
  state.messages = [];
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  state.db?.close();
  state.db = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('cron 无人值守运行发现 MCP 401 → 收件箱每连接器每日至多一条', () => {
  it('同日两次运行只落 1 条；换一天再落第 2 条', async () => {
    const action = job.action as never;
    vi.setSystemTime(new Date(2031, 2, 10, 9, 0, 0));
    await executeCronAgentAction(host, job, action, 'e1');
    vi.setSystemTime(new Date(2031, 2, 10, 21, 30, 0));
    await executeCronAgentAction(host, job, action, 'e2');

    expect(state.messages.map((m) => m.id)).toEqual(['automation:connector_lost:notion:2031-03-10']);
    const sameDay = automationRows();
    fs.appendFileSync(EVIDENCE, `same-day rows: ${JSON.stringify(sameDay)}\nsame-day inbox messages: ${JSON.stringify(state.messages)}\n`);
    const pending = (sameDay[0].config_json as { pendingReview: { connectorLost: { days: Record<string, string>; summary: string } } }).pendingReview;
    expect(pending.connectorLost.days).toEqual({ notion: '2031-03-10' });
    expect(pending.connectorLost.summary).toContain('今天的定时运行没能读取');
    expect(pending.connectorLost.summary).not.toMatch(/mcp_|lost_login|过期|撤销/);

    vi.setSystemTime(new Date(2031, 2, 11, 9, 0, 0));
    await executeCronAgentAction(host, job, action, 'e3');
    expect(state.messages.map((m) => m.id)).toEqual([
      'automation:connector_lost:notion:2031-03-10',
      'automation:connector_lost:notion:2031-03-11',
    ]);
    const nextDay = automationRows();
    fs.appendFileSync(EVIDENCE, `next-day rows: ${JSON.stringify(nextDay)}\nnext-day inbox messages: ${JSON.stringify(state.messages)}\n`);
    expect((nextDay[0].config_json as { pendingReview: { connectorLost: { days: Record<string, string> } } }).pendingReview.connectorLost.days)
      .toEqual({ notion: '2031-03-11' });
  });

  it('没有 401 标记的失败 / 成功运行不写收件箱', async () => {
    state.orchestratorMessages = [{ role: 'tool', toolResults: [
      { toolCallId: 't1', success: false, error: 'boom', metadata: { server: 'notion' } },
      { toolCallId: 't2', success: true, output: 'ok', metadata: { mcpAuthorizationRequired: true, server: 'notion' } },
    ] }];
    vi.setSystemTime(new Date(2031, 5, 1, 9, 0, 0));
    await executeCronAgentAction(host, job, job.action as never, 'e4');
    expect(state.messages).toEqual([]);
  });

  it('运行前预检：角色声明的 CLI 连接器探测确认未登录 → 记一条（文案用显示名）；stale 不记', async () => {
    state.orchestratorMessages = [];
    const action = { ...(job.action as object), roleId: 'feishu-expert' } as never;
    replaceCliConnectorConnectionStatusCache([{ id: 'feishu', connected: false }]); // 无 lostReason（stale/未分类）
    vi.setSystemTime(new Date(2031, 8, 1, 9, 0, 0));
    await executeCronAgentAction(host, job, action, 'e5');
    expect(state.messages).toEqual([]);

    replaceCliConnectorConnectionStatusCache([{ id: 'feishu', connected: false, lostReason: 'cli_not_logged_in' }]);
    await executeCronAgentAction(host, job, action, 'e6');
    await executeCronAgentAction(host, job, action, 'e7');
    expect(state.messages.map((m) => m.id)).toEqual(['automation:connector_lost:feishu:2031-09-01']);
    expect(JSON.stringify(automationRows())).toContain('今天的定时运行没能读取「');
    replaceCliConnectorConnectionStatusCache([]);
  });
});
