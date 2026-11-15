// 停车审批保留来源（N-APPROVAL-CARD-USER-QUOTE-FU1-FIX ②）：
// 走生产入口 OrchestratorPermissionIsland.requestPermission 写 pending_approvals，
// 再由 listParkedApprovals 读回；不手拼 payload。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { AppSettings, Message } from '../../../src/shared/contract';
import { DEFAULT_SETTINGS } from '../../../src/host/services/core/configDefaults';

const state = vi.hoisted(() => ({ repo: null as unknown, pending: null as unknown, session: null as unknown }));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
vi.mock('../../../src/host/services/infra/notificationService', () => ({ notificationService: { notifyNeedsInput: vi.fn() } }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getSession: () => state.session,
    getRecentMessages: (id: string, n: number) => (state.repo as { getRecentMessages(i: string, c: number): Message[] }).getRecentMessages(id, n),
    getPendingApprovalRepo: () => state.pending,
    getDb: () => null,
  }),
}));
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getSessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';

let db: Database.Database;
let pending: PendingApprovalRepository;

function parkBash() {
  const island = new OrchestratorPermissionIsland({
    getSettings: () => ({ ...DEFAULT_SETTINGS, permissions: { ...DEFAULT_SETTINGS.permissions, autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [] } }) as AppSettings,
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'main',
    hasApprovalUi: () => false,
    onEvent: vi.fn(),
    injectedPendingApprovalRepo: pending,
  });
  getPermissionModeManager().markUnattendedSession('s1');
  void island.requestPermission({ type: 'command', tool: 'Bash', details: { command: 'ls notes' }, sessionId: 's1' });
}

describe('parked tool_approval keeps who started the run', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    applyTestSessionSchema(db);
    db.prepare(`INSERT INTO sessions (id, title, model_provider, model_name, working_directory, created_at, updated_at) VALUES ('s1','t','moonshot','kimi-k2.5','/tmp',1,1)`).run();
    state.repo = new SessionRepository(db);
    pending = new PendingApprovalRepository(db);
    state.pending = pending;
    resetPermissionModeManager();
  });
  afterEach(() => { db.close(); resetPermissionModeManager(); });

  it('② cron origin: payload_json and the inbox row carry startedByAutomation + task name, no quote', () => {
    state.session = { title: 't', origin: { kind: 'cron', id: 'cron-1', name: '每日飞书日历周会' } };
    (state.repo as SessionRepository).addMessage('s1', { id: 'm1', role: 'user', content: 'scheduled prompt', timestamp: 1000 } as unknown as Message);
    parkBash();
    const raw = db.prepare('SELECT payload_json FROM pending_approvals').get() as { payload_json: string };
    const payload = JSON.parse(raw.payload_json);
    expect(payload.startedByAutomation).toBe(true);
    expect(payload.scheduledTaskName).toBe('每日飞书日历周会');
    expect(payload.userRequest).toBeUndefined();
    const [item] = getSessionAutomationService().listParkedApprovals();
    expect(item.startedByAutomation).toBe(true);
    expect(item.scheduledTaskName).toBe('每日飞书日历周会');
    expect(item.userRequest).toBeUndefined();
  });

  it('② manual turn: userRequest is kept, no automation fields', () => {
    state.session = { title: 't', origin: { kind: 'manual' } };
    (state.repo as SessionRepository).addMessage('s1', { id: 'm1', role: 'user', content: '把笔记整理到一个文件', timestamp: 1000 } as unknown as Message);
    parkBash();
    const [item] = getSessionAutomationService().listParkedApprovals();
    expect(item.userRequest).toEqual({ text: '把笔记整理到一个文件', truncated: false });
    expect(item.startedByAutomation).toBeUndefined();
    expect(item.scheduledTaskName).toBeUndefined();
  });
});
