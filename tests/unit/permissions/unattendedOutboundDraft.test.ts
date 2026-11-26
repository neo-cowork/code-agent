import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, PermissionRequest } from '../../../src/shared/contract';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  currentUser: vi.fn<() => { id: string } | null>(),
  execute: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  handlers: new Map<string, (event: unknown, request: IPCRequest) => Promise<IPCResponse>>(),
}));

vi.unmock('better-sqlite3');
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('../../../src/host/services/auth', () => ({ getAuthService: () => ({ getCurrentUser: mocks.currentUser }) }));
vi.mock('../../../src/host/tools/toolExecutor', () => ({ ToolExecutor: class { execute = mocks.execute; } }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger, logger: mocks.logger, default: mocks.logger,
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn(), retractNeedsInput: vi.fn() },
}));
vi.mock('../../../src/host/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/platform')>(),
  ipcHost: { handle: (channel: string, handler: (event: unknown, request: IPCRequest) => Promise<IPCResponse>) => {
    mocks.handlers.set(channel, handler);
  } },
}));

import Database from 'better-sqlite3';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { computeLedgerArgsSurvival } from '../../../src/host/agent/parkedApprovalSurvival';
import { takeUnattendedApprovalDenials } from '../../../src/host/agent/unattendedApprovalTerminal';
import { registerSessionAutomationHandlers } from '../../../src/host/ipc/sessionAutomation.ipc';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../../src/shared/constants/defaults';
import { INTERACTION_TIMEOUTS } from '../../../src/shared/constants/timeouts';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { OutboundDraftInboxItem } from '../../../src/shared/contract/pendingApproval';

const SESSION_ID = 'weekly-summary';
const TASK_NAME = 'Email me the weekly summary';
const BODY = 'This week, the team completed the review and scheduled the next meeting. '.repeat(20);
const DEGRADE = INTERACTION_TIMEOUTS.UNATTENDED_PARKED_APPROVAL_DEGRADE;

describe('unattended mail drafts through parked approval timeout and sessionAutomation IPC', () => {
  let directory: string;
  let database: BetterSqlite3.Database;
  let repo: PendingApprovalRepository;
  let sessions: SessionRepository;
  let island: OrchestratorPermissionIsland;
  let args: Record<string, unknown>;
  let attachment: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    resetPermissionModeManager();
    directory = mkdtempSync(join(tmpdir(), 'outbound-draft-test-'));
    database = new Database(join(directory, 'neo.db'));
    const logger = mocks.logger as unknown as Parameters<typeof applySchema>[1];
    applySchema(database, logger);
    applySessionsMigrations(database, logger);
    applyConversationBranchSchema(database, { backfillLegacy: false });
    repo = new PendingApprovalRepository(database);
    sessions = new SessionRepository(database);
    mocks.getDatabase.mockReturnValue({
      getPendingApprovalRepo: () => repo,
      getMessages: (id: string) => sessions.getMessages(id),
      getSession: (...params: Parameters<SessionRepository['getSession']>) => sessions.getSession(...params),
    });
    sessions.createSession({
      id: SESSION_ID, title: TASK_NAME, status: 'running', workingDirectory: directory,
      modelConfig: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
      createdAt: Date.now(), updatedAt: Date.now(), origin: { kind: 'cron', name: TASK_NAME },
    });
    mocks.currentUser.mockReturnValue(null);
    mocks.execute.mockResolvedValue({ success: true });
    attachment = join(directory, 'weekly-summary.txt');
    writeFileSync(attachment, 'Original weekly summary');
    args = {
      to: ['reviewer@example.invalid'], cc: ['team@example.invalid'], bcc: ['archive@example.invalid'],
      subject: 'Weekly summary', content: BODY, attachments: [attachment],
    };
    const modes = getPermissionModeManager();
    modes.markUnattendedSession(SESSION_ID);
    modes.markUnattendedApprovalDegrade(SESSION_ID);
    island = new OrchestratorPermissionIsland({
      getSettings: () => ({
        permissions: { autoApprove: {}, blockedCommands: [], devModeAutoApprove: false },
      } as unknown as AppSettings),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      isDetachedRun: () => false,
      onEvent: vi.fn(),
      injectedPendingApprovalRepo: repo,
    });
    registerSessionAutomationHandlers();
  });

  afterEach(() => {
    takeUnattendedApprovalDenials(SESSION_ID);
    resetPermissionModeManager();
    vi.useRealTimers();
    database.close();
    rmSync(directory, { force: true, recursive: true });
  });

  function requestMail({ ledger = true } = {}) {
    const callId = 'send-weekly-summary';
    if (ledger) sessions.addMessage(SESSION_ID, {
      id: 'assistant-call', role: 'assistant', content: '', timestamp: Date.now(),
      toolCalls: [{ id: callId, name: 'mail_send', arguments: args }],
    });
    return island.requestPermission({
      type: 'mcp', tool: 'mail_send', sessionId: SESSION_ID, parentToolUseId: callId,
      details: { startedByAutomation: true, scheduledTaskName: TASK_NAME },
      ...computeLedgerArgsSurvival('mail_send', args),
    });
  }

  async function call<T>(action: string, payload?: Record<string, unknown>): Promise<T> {
    const response = await mocks.handlers.get(IPC_DOMAINS.SESSION_AUTOMATION)!(null, { action, payload } as IPCRequest);
    expect(response).toMatchObject({ success: true });
    return response.data as T;
  }

  const list = () => call<OutboundDraftInboxItem[]>('listOutboundDrafts');
  const decide = ({ id, revision }: OutboundDraftInboxItem, decision = 'send') =>
    call<string>('resolveOutboundDraft', { id, revision, decision });

  async function expireApproval() {
    const live = requestMail();
    await vi.advanceTimersByTimeAsync(DEGRADE);
    const denial = await live;
    expect(denial).toMatchObject({ approved: false, denialSource: 'timeout' });
    expect(denial.message).toContain('OUTBOUND_DRAFT_SAVED');
    expect(denial.message).toContain('The email was not sent');
    expect(denial.message).not.toContain('未读取');
    const [draft] = await list();
    expect(draft).toBeDefined();
    return draft!;
  }

  it('keeps all recipients and the full body, sends only once after Send, and keeps the body out of logs', async () => {
    const live = requestMail();
    await vi.advanceTimersByTimeAsync(DEGRADE - 1);
    expect(await list()).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(live).resolves.toMatchObject({ approved: false, denialSource: 'timeout', message: expect.stringContaining('OUTBOUND_DRAFT_SAVED') });
    const [draft] = await list();
    expect(draft).toMatchObject({
      scheduledTaskName: TASK_NAME, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject,
      body: BODY, attachmentNames: ['weekly-summary.txt'], needsReconfirm: false,
    });
    const row = repo.getById(draft!.id)!;
    expect(row).toMatchObject({ kind: 'outbound_draft', status: 'pending' });
    expect(JSON.parse(row.payloadJson)).toMatchObject({
      tool: 'mail_send', args, argsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      attachmentFingerprints: [expect.stringMatching(/^[a-f0-9]{64}$/)], createdAt: row.submittedAt,
    });
    expect(repo.listByKindAndStatus('tool_approval', 'rejected')).toHaveLength(1);
    expect(mocks.execute).not.toHaveBeenCalled();

    mocks.execute.mockImplementationOnce((_tool: string, sent: { attachments: string[] }) => {
      expect(readFileSync(sent.attachments[0]!, 'utf8')).toBe('Original weekly summary');
      return { success: true };
    });
    expect(await Promise.all([decide(draft!), decide(draft!)])).toEqual(['OUTBOUND_DRAFT_SENT', 'OUTBOUND_DRAFT_CLOSED']);
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('mail_send', expect.objectContaining({ to: args.to, content: BODY }), expect.objectContaining({ currentToolCallId: row.id }));
    expect(repo.getById(row.id)).toMatchObject({ status: 'approved', payloadJson: 'null', feedback: 'OUTBOUND_DRAFT_SENT' });
    expect(mocks.logger.info).toHaveBeenCalledWith('Unattended mail draft created', expect.objectContaining({ draftId: row.id }));
    for (const log of Object.values(mocks.logger)) expect(JSON.stringify(log.mock.calls)).not.toContain(BODY.slice(0, 50));
  });

  it('blocks changed attachment bytes and accepts only a fresh Send after review', async () => {
    const draft = await expireApproval();
    writeFileSync(attachment, 'Revised weekly summary');
    expect(await decide(draft)).toBe('OUTBOUND_DRAFT_RECONFIRM');
    expect(mocks.execute).not.toHaveBeenCalled();
    const [refreshed] = await list();
    expect(refreshed).toMatchObject({ id: draft.id, needsReconfirm: true });
    expect(refreshed!.revision).not.toBe(draft.revision);
    expect(await decide(draft)).toBe('OUTBOUND_DRAFT_RECONFIRM');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(await decide(refreshed!)).toBe('OUTBOUND_DRAFT_SENT');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('blocks tampered recipients and keeps a discarded draft closed across replay', async () => {
    const draft = await expireApproval();
    const row = repo.getById(draft.id)!;
    repo.updatePayloadJson(row.id, JSON.stringify({
      ...JSON.parse(row.payloadJson),
      args: { ...args, to: ['different@example.invalid'] },
    }));
    expect(await decide(draft)).toBe('OUTBOUND_DRAFT_RECONFIRM');
    const [refreshed] = await list();
    expect(refreshed).toMatchObject({ to: ['different@example.invalid'], needsReconfirm: true });
    expect(await decide(refreshed!, 'discard')).toBe('OUTBOUND_DRAFT_DISCARDED');
    expect(await decide(refreshed!)).toBe('OUTBOUND_DRAFT_CLOSED');
    expect(await decide(draft)).toBe('OUTBOUND_DRAFT_CLOSED');
    expect(await list()).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('closes an expired draft and refuses to expose or resolve another owner’s draft', async () => {
    const draft = await expireApproval();
    mocks.currentUser.mockReturnValue({ id: 'different-owner' });
    expect(await list()).toEqual([]);
    expect(await decide(draft)).toBe('OUTBOUND_DRAFT_CLOSED');
    expect(await decide(draft, 'discard')).toBe('OUTBOUND_DRAFT_CLOSED');
    mocks.currentUser.mockReturnValue(null);
    vi.setSystemTime(Date.now() + INTERACTION_TIMEOUTS.OUTBOUND_DRAFT_RETENTION);
    expect(await list()).toEqual([]);
    expect(await decide(draft)).toBe('OUTBOUND_DRAFT_EXPIRED');
    expect(repo.getById(draft.id)).toMatchObject({ status: 'rejected', payloadJson: 'null' });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('falls back to a distinguishable denial when the ledger args are unavailable', async () => {
    const result = requestMail({ ledger: false });
    await vi.advanceTimersByTimeAsync(DEGRADE);
    expect(await result).toMatchObject({ approved: false, denialSource: 'timeout', message: expect.stringContaining('未发送') });
    expect(await list()).toEqual([]);
    expect(mocks.logger.warn).toHaveBeenCalledWith('Unattended mail draft could not be prepared', expect.objectContaining({ reason: 'args_unavailable' }));
  });

  it('keeps detached foreground mail out of the unattended draft flow', async () => {
    resetPermissionModeManager();
    const detached = new OrchestratorPermissionIsland({
      getSettings: () => ({ permissions: { autoApprove: {} } }) as AppSettings,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent', hasApprovalUi: () => false,
      isDetachedRun: () => true, onEvent: vi.fn(), injectedPendingApprovalRepo: repo,
    });
    const request: Omit<PermissionRequest, 'id' | 'timestamp'> = { type: 'mcp', tool: 'mail_send', details: {}, sessionId: SESSION_ID };
    const live = detached.requestPermission(request);
    await vi.advanceTimersByTimeAsync(DEGRADE);
    expect(await live).toMatchObject({ approved: false, denialSource: 'timeout' });
    expect(await list()).toEqual([]);
  });
});
