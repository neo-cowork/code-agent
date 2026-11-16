// @vitest-environment jsdom
// The only transport seam is renderer IPC -> the production permission island.
// Both live cards and restart/parked projections consume host-produced payloads.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { AgentEvent, Message, PermissionRequest, PermissionResponse } from '../../../src/shared/contract';
import type { ParkedApprovalInboxItem } from '../../../src/shared/contract/pendingApproval';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { DEFAULT_SETTINGS } from '../../../src/host/services/core/configDefaults';
import { zh } from '../../../src/renderer/i18n/zh';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  repo: null as unknown,
  pending: null as unknown,
  items: [] as ParkedApprovalInboxItem[],
  respond: vi.fn(),
}));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', () => {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: () => logger, logger };
});
vi.mock('../../../src/host/services/infra/notificationService', () => ({ notificationService: { notifyNeedsInput: vi.fn() } }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getSession: (id: string) => (state.repo as SessionRepository).getSession(id),
    getRecentMessages: (id: string, count: number) => (state.repo as SessionRepository).getRecentMessages(id, count),
    getPendingApprovalRepo: () => state.pending,
    getDb: () => state.db,
  }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh, language: 'zh' }) }));
vi.mock('../../../src/renderer/stores/appStore', () => {
  const value = {
    pendingPermissionRequest: null, pendingPermissionSessionId: null,
    queuedPermissionRequests: {}, resolvedPermissionRequests: {},
    setPendingPermissionRequest: vi.fn(), dismissPermissionRequest: vi.fn(), recordPermissionDecision: vi.fn(),
  };
  return { useAppStore: (select?: (v: typeof value) => unknown) => select ? select(value) : value };
});
vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const value = { currentSessionId: 's1', loadSessions: vi.fn(), switchSession: vi.fn() };
  return { useSessionStore: Object.assign((select: (v: typeof value) => unknown) => select(value), { getState: () => value }) };
});
vi.mock('../../../src/renderer/stores/parkedApprovalStore', () => ({
  useParkedApprovals: () => state.items, refreshParkedApprovals: vi.fn(),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke: (...args: unknown[]) => state.respond(...args) },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getSessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';
import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { ParkedApprovalCards } from '../../../src/renderer/components/features/chat/ParkedApprovalCards';

const userWords = '明天上午10点在飞书日历加一个叫周会的日程';
const taskName = '工作日飞书晨会';
const tool = 'mcp__lark__calendar_v4_calendarEvent_create';
let db: Database.Database;
let island: OrchestratorPermissionIsland;
let events: AgentEvent[];
const executor = vi.fn();

function start(cron: boolean, parked = false, sameTitle = true) {
  const origin = cron ? { kind: 'cron', id: 'cron-1', name: taskName } : { kind: 'manual' };
  db.prepare(`INSERT INTO sessions (id,title,model_provider,model_name,working_directory,origin,created_at,updated_at)
    VALUES ('s1',?,'test','test','/tmp',?,1,1)`).run('同步下周会议', JSON.stringify(origin));
  if (cron && sameTitle) {
    db.prepare(`INSERT INTO session_automations (id,type,status,title,source_ref_id,created_at,updated_at)
      VALUES ('a1','cron','active',?,'cron-1',1,1)`).run(taskName);
  }
  (state.repo as SessionRepository).addMessage('s1', {
    id: 'user-1', role: 'user', content: cron ? '每个工作日上午在飞书日历添加晨会' : userWords, timestamp: 1000,
  } as Message);
  if (parked) getPermissionModeManager().markUnattendedSession('s1');
  island = new OrchestratorPermissionIsland({
    getSettings: () => ({ ...DEFAULT_SETTINGS, permissions: {
      ...DEFAULT_SETTINGS.permissions, autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [],
    } }),
    isDevModeAutoApproveEnabled: () => false, getExecutionTopology: () => 'main',
    hasApprovalUi: () => !parked, onEvent: (event) => events.push(event),
    injectedPendingApprovalRepo: state.pending as PendingApprovalRepository,
  });
  state.respond.mockImplementation((channel: string, id: string, response: PermissionResponse) => {
    expect(channel).toBe(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE);
    return island.handlePermissionResponse(id, response);
  });
  // A positive result is the only route to the connected write executor.
  const completion = island.requestPermission({ type: 'mcp', tool, sessionId: 's1', details: { server: 'lark', toolName: 'calendar_v4_calendarEvent_create' } })
    .then((result) => { if (result.approved) executor(); return result; });
  const event = events.find((item) => item.type === 'permission_request');
  expect(event).toBeDefined();
  const payload = event!.data as PermissionRequest;
  expect(payload.details.connectorAccess).toMatchObject({ connectorId: 'lark', access: 'write' });
  return { payload, completion };
}

async function deny(completion: ReturnType<typeof start>['completion']) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${zh.decisionCard.permission.optionDeny}`) }));
    expect(await completion).toMatchObject({ approved: false, denialSource: 'user' });
  });
  await waitFor(() => expect(state.respond).toHaveBeenCalled());
  expect(executor).not.toHaveBeenCalled();
}

describe('Feishu connector approval host -> renderer chain', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    applyTestSessionSchema(db);
    state.db = db;
    state.repo = new SessionRepository(db);
    state.pending = new PendingApprovalRepository(db);
    state.items = [];
    state.respond.mockReset();
    executor.mockClear();
    events = [];
    resetPermissionModeManager();
  });
  afterEach(() => {
    cleanup();
    island?.drainPendingPermissions();
    db.close();
    state.db = null;
    resetPermissionModeManager();
  });

  it('① manual request preserves original words byte-for-byte, displays the quote, deny never executes', async () => {
    const { payload, completion } = start(false);
    expect(payload.details.userRequest?.text).toBe(userWords);
    render(<PermissionCard requestOverride={payload} sessionIdOverride="s1" />);
    expect(screen.getByTestId('user-request-quote').textContent).toBe(`来自你的消息：「${userWords}」`);
    expect(screen.queryAllByTestId('scheduled-task-origin')).toHaveLength(0);
    await deny(completion);
  });

  it.each([true, false])('② cron event: same title=%s, one origin and 0/1 purpose rows, deny never executes', async (sameTitle) => {
    const { payload, completion } = start(true, true, sameTitle);
    expect(payload.details.userRequest).toBeUndefined();
    expect(payload.details.scheduledTaskName).toBe(taskName);
    expect(payload.details.purpose).toBe(sameTitle ? taskName : '同步下周会议');
    render(<PermissionCard requestOverride={payload} sessionIdOverride="s1" />);
    expect(screen.getAllByTestId('scheduled-task-origin')).toHaveLength(1);
    expect(screen.getByTestId('scheduled-task-origin').textContent).toBe(`由定时任务「${taskName}」启动`);
    expect(screen.queryAllByTestId('user-request-quote')).toHaveLength(0);
    expect(screen.queryAllByTestId('connector-purpose')).toHaveLength(sameTitle ? 0 : 1);
    await deny(completion);
  });

  it('② parked DB -> listParkedApprovals -> ParkedApprovalCards retains task name, deny never executes', async () => {
    const { completion } = start(true, true);
    const row = db.prepare('SELECT payload_json FROM pending_approvals').get() as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toMatchObject({ startedByAutomation: true, scheduledTaskName: taskName });
    state.items = getSessionAutomationService().listParkedApprovals();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ startedByAutomation: true, scheduledTaskName: taskName });
    render(<ParkedApprovalCards />);
    expect(screen.getAllByTestId('scheduled-task-origin')).toHaveLength(1);
    expect(screen.getByTestId('scheduled-task-origin').textContent).toBe(`由定时任务「${taskName}」启动`);
    expect(screen.queryAllByTestId('user-request-quote')).toHaveLength(0);
    await deny(completion);
    expect((db.prepare('SELECT status FROM pending_approvals').get() as { status: string }).status).toBe('rejected');
  });
});
