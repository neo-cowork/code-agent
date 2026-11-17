import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Session } from '../../../../src/shared/contract';
import type { ConfigService } from '../../../../src/host/services/core/configService';
import type { ToolContext, CanUseToolFn } from '../../../../src/host/protocol/tools';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { applySessionsMigrations, applyTelemetryTurnsMigrations } from '../../../../src/host/services/core/database/migrations';
import { applyConversationBranchSchema } from '../../../../src/host/services/core/database/schemaConversationBranch';
import { SessionRepository } from '../../../../src/host/services/core/repositories/SessionRepository';
import { DEFAULT_SETTINGS } from '../../../../src/host/services/core/configDefaults';
import { ModelRouter } from '../../../../src/host/model/modelRouter';
import { resetTaskManager, getTaskManager } from '../../../../src/host/task/TaskManager';
import { resetSessionCommandCenterForTest } from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { resetBackgroundTaskLedgerForTest } from '../../../../src/host/task/backgroundTaskLedger';
import { executeDelegateTask } from '../../../../src/host/tools/modules/commandCenter/sessionCommandCenter';
import { backfillMissingTelemetryUserPrompts } from '../../../../src/host/services/infra/sessionManagerTelemetryBackfill';
import { buildTranscriptReplay } from '../../../../src/host/telemetry/replay/transcriptReplayBuilder';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';

// Internal scaffolding of the delegated prompt: it must reach the model, never a stored user row.
const DELEGATED_SCAFFOLDING_MARKERS = ['<drafted_task_plan>', '<original_user_request', 'This task covers only'] as const;

const repo = () => store.sessions as SessionRepository;
const store = vi.hoisted(() => ({ db: undefined as unknown, sessions: undefined as unknown }));
const databaseStub = vi.hoisted(() => () => {
  const repoOf = () => store.sessions as SessionRepository;
  const known: Record<string, unknown> = {
    getDb: () => store.db,
    addMessage: (id: string, message: Message) => repoOf().addMessage(id, message),
    getSession: (id: string) => repoOf().getSession(id),
    getMessages: (id: string) => repoOf().getMessages(id),
    listSessions: () => [],
    listMemories: () => [],
    getTodos: () => [],
    getSessionTasks: () => [],
  };
  // The agent loop touches many unrelated persistence helpers; unknown ones are inert.
  return new Proxy(known, { get: (target, key) => (key in target ? target[key as string] : () => undefined) });
});
vi.mock('../../../../src/host/services/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), getDatabase: databaseStub,
}));
vi.mock('../../../../src/host/services/core/databaseService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), getDatabase: databaseStub,
}));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getCurrentSessionId: () => 'chat-session',
    getSession: async (id: string) => { const s = repo().getSession(id); return s ? { ...s, messages: repo().getMessages(id) } : null; },
    getMessages: async (id: string) => repo().getMessages(id),
    addMessageToSession: async (id: string, message: Message) => repo().addMessage(id, message),
    updateSession: async (id: string, updates: Partial<Session>) => repo().updateSession(id, updates),
    getSessionMetadata: () => undefined,
    getTodos: async () => [],
    saveTodos: async () => {},
  }),
}));
vi.mock('../../../../src/host/agent/agentRequirementsAnalyzer', () => ({
  getAgentRequirementsAnalyzer: () => ({ analyze: async () => ({ needsAutoAgent: false }) }),
}));
vi.mock('../../../../src/host/agent/orchestrator/agentRoutingResolver', () => ({ resolveAgentRouting: async () => null }));
vi.mock('../../../../src/host/services/wake/userReturn', () => ({ cancelTimeWakesOnUserReturn: async () => {} }));

const PLAN = 'Read the contract PDF in the workspace and summarize it.';

describe('delegate_task persists only the drafted plan as the background run user row', () => {
  let root: string;
  let db: Database.Database;
  let requests: string[];

  beforeEach(() => {
    vi.stubEnv('CODE_AGENT_MODEL_ENGINE', 'legacy');
    vi.stubEnv('EVAL_DISABLED', 'true');
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'delegated-prompt-')));
    db = new Database(':memory:');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    applySchema(db, logger as never);
    applySessionsMigrations(db, logger as never);
    applyTelemetryTurnsMigrations(db, logger as never);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    store.db = db;
    store.sessions = new SessionRepository(db);
    repo().createSession({
      id: 'chat-session', title: 'Contract', modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
      workingDirectory: root, createdAt: 1, updatedAt: 1, status: 'idle',
    } as Session);
    repo().addMessage('chat-session', {
      id: 'user-1', role: 'user', content: 'Read the contract PDF and summarize it, do it in the background.', timestamp: 2,
    } as Message);
    requests = [];
    vi.spyOn(ModelRouter.prototype, 'inference').mockImplementation(async (messages) => {
      requests.push(JSON.stringify(messages));
      return { type: 'text', content: 'The summary is ready.', finishReason: 'stop' } as never;
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.models = { ...settings.models, default: 'xiaomi', providers: { xiaomi: { enabled: true, apiKey: 'fixture-key', model: 'mimo-v2.6-flash' } } };
    const config = { getSettings: () => settings, getApiKey: () => 'fixture-key', getServiceApiKey: () => '', isDevModeAutoApproveEnabled: () => false } as unknown as ConfigService;
    resetTaskManager();
    resetSessionCommandCenterForTest();
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
    getTaskManager().initialize({ configService: config, onAgentEvent: () => {} });
  });

  afterEach(() => {
    resetSessionCommandCenterForTest();
    resetTaskManager();
    resetBackgroundTaskLedgerForTest();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  it('keeps scaffolding model-facing only, including after telemetry backfill', async () => {
    const scope = createWorkspaceScope('project-chat', [{ sourceId: 'src', path: root, role: 'primary', access: 'read_write' }]);
    const ctx = {
      sessionId: 'chat-session', workspace: root, workspaceScope: scope, sourceMessageId: 'user-1',
      abortSignal: new AbortController().signal, logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ToolContext;
    const allow = vi.fn().mockResolvedValue({ allow: true }) as CanUseToolFn;
    const result = await executeDelegateTask({
      title: 'Summarize contract', short_name: 'Contract', lane_key: 'contract', submission_key: 'contract-1', prompt: PLAN,
    }, ctx, allow);
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 5000 });
    await vi.waitFor(() => {
      const row = db.prepare("select count(*) as n from telemetry_turns where session_id = 'chat-session'").get() as { n: number };
      expect(row.n).toBeGreaterThan(0);
    }, { timeout: 5000 });

    backfillMissingTelemetryUserPrompts('chat-session');

    const userRows = db.prepare("select content, is_meta from messages where session_id = 'chat-session' and role = 'user'").all() as Array<{ content: string; is_meta: number }>;
    const prompts = db.prepare("select user_prompt from telemetry_turns where session_id = 'chat-session'").all() as Array<{ user_prompt: string }>;
    // Replay built from the transcript shows the plan sentence as the delegated row, with no scaffolding.
    const replay = buildTranscriptReplay('chat-session', () => ({}) as never);
    const replayUserText = (replay?.turns ?? []).flatMap((turn) => turn.blocks).filter((block) => block.type === 'user').map((block) => block.content);
    expect(replayUserText).toContain(PLAN);
    expect(userRows.some((row) => row.is_meta === 1 && row.content === PLAN)).toBe(true);
    for (const marker of DELEGATED_SCAFFOLDING_MARKERS) {
      for (const row of userRows) expect(row.content).not.toContain(marker);
      for (const row of prompts) expect(row.user_prompt ?? '').not.toContain(marker);
      expect(requests.join('\n')).toContain(marker);
    }
  });
});
