import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { Message } from '../../../src/shared/contract';
import type { ToolContext } from '../../../src/host/protocol/tools';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { computeLedgerArgsSurvival, hashLedgerFormArgs } from '../../../src/host/agent/parkedApprovalSurvival';
import { sanitizeToolCallsForHistory } from '../../../src/host/agent/messageHandling/converter';
import { hydrateApprovalGatesAtBoot } from '../../../src/host/agent/parkedApprovalHydration';
import { resumeSurvivingParkedApproval } from '../../../src/host/agent/parkedApprovalResume';
import { cleanXmlResidues } from '../../../src/host/agent/antiPattern/cleanXml';
import { writeModule } from '../../../src/host/tools/modules/file/write';
import { SessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';

const state = vi.hoisted(() => ({ repo: null as unknown, messages: [] as Message[], title: '', origin: 'channel' }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getPendingApprovalRepo: () => state.repo,
    getSession: () => ({ title: state.title, origin: { kind: state.origin } }),
    getMessages: () => state.messages,
  }),
}));
vi.mock('../../../src/host/agent/planApproval', () => ({ getPlanApprovalGate: () => ({ attachPersistence: () => 0 }) }));
vi.mock('../../../src/host/agent/swarmLaunchApproval', () => ({ getSwarmLaunchApprovalGate: () => ({ attachPersistence: () => 0 }) }));
vi.mock('../../../src/host/tools/lsp/diagnosticsHelper', () => ({ getPostEditDiagnostics: async () => null }));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));

const content = '  - 完成周报\n- 核对数据\n- 安排下周计划\n';
const args = { file_path: 'weekly.md', content };
const ledgerArgs = (tool: string, input: Record<string, unknown>) =>
  sanitizeToolCallsForHistory([{ id: 'write-call', name: tool, arguments: input }])![0].arguments;

describe('parked file approval preserves original arguments', () => {
  it.each([
    ['Write', args], ['write_file', args], ['Append', args],
    ['Edit', { file_path: 'weekly.md', edits: [{ old_text: 'before', new_text: 'after' }] }],
    ['edit_file', { file_path: 'weekly.md', old_text: 'before', new_text: 'after' }],
    ['Write', { file_path: 'weekly.md', content: 'a'.repeat(272) }],
  ])('%s: derived annotations do not lose information', (tool, input) => {
    const survival = computeLedgerArgsSurvival(tool, input);
    const stored = ledgerArgs(tool, input);
    expect(survival.ledgerFaithful).toBe(true);
    expect(survival.argsFingerprint).toBe(hashLedgerFormArgs(stored));
    expect(hashLedgerFormArgs(ledgerArgs(tool, stored))).toBe(survival.argsFingerprint);
  });

  it.each([
    ['Write', { file_path: 'weekly.md', content: 'a'.repeat(273) }],
    ['Append', { file_path: 'weekly.md', content: 'a'.repeat(300) }],
    ['Edit', { edits: [{ old_text: 'a'.repeat(300), new_text: 'after' }] }],
    ['edit_file', { old_text: 'before', new_text: 'a'.repeat(300) }],
    ['Write', { ...args, content_length: -1 }],
  ])('%s: truncation or overwritten original metadata still fails closed', (tool, input) => {
    expect(computeLedgerArgsSurvival(tool, input).ledgerFaithful).toBe(false);
  });
});

describe('Write through boot hydration and approved ledger replay', () => {
  let db: InstanceType<typeof Database>;
  let repo: PendingApprovalRepository;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'parked-write-'));
    db = new Database(join(dir, 'approval.db'));
    db.exec(`CREATE TABLE pending_approvals (
      id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
      payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT)`);
    repo = new PendingApprovalRepository(db);
    state.repo = repo;
    state.title = '[Channel] Feishu test · oc_example';
    state.origin = 'channel';
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function seed(input = args) {
    state.messages = [
      { id: 'old-user', role: 'user', content: '整理上周账单', timestamp: 1 },
      { id: 'request', role: 'user', content: '新建 weekly.md 写三条要点', timestamp: 2 },
      { id: 'assistant', role: 'assistant', content: '', timestamp: 3,
        toolCalls: [{ id: 'write-call', name: 'Write', arguments: ledgerArgs('Write', input) }] },
      { id: 'later-user', role: 'user', content: '这是后来的其他任务', timestamp: 4 },
    ];
    repo.insert({ id: 'approval', kind: 'tool_approval', agentId: null, agentName: null, coordinatorId: 'channel-session',
      submittedAt: 1_000, payload: {
        sessionId: 'channel-session', toolCallId: 'write-call', tool: 'Write', type: 'file', permissionLevel: 'write', requestedAt: 1_000,
        argsRef: { sessionId: 'channel-session', toolCallId: 'write-call' }, ...computeLedgerArgsSurvival('Write', cleanXmlResidues(input) as Record<string, unknown>),
      } });
  }
  function hydrate() {
    return hydrateApprovalGatesAtBoot(repo, 2_000, {
      loadSessionMessages: () => state.messages, resolveWorkingDirectory: () => dir,
      resolveSessionOriginKind: () => state.origin,
      persistToolMessage: async (_id, message) => { state.messages.push(message); },
    });
  }

  it.each(['local', 'channel'])('%s: stays pending, then real Write receives ledger content and writes exact bytes once', async (origin) => {
    state.origin = origin;
    seed();
    expect(hydrate().survived).toBe(1);
    expect(repo.getById('approval')).toMatchObject({ status: 'pending', feedback: null });
    expect(JSON.parse(repo.getById('approval')!.payloadJson).displayTool).toBe('重启前发起 · Write');
    const executeTool = vi.fn(async (input: { arguments: Record<string, unknown> }) => {
      expect(input.arguments).toEqual({ ...args, content_length: content.length });
      const context: ToolContext = { sessionId: 'channel-session', agentId: 'file-writer', workingDir: dir,
        abortSignal: new AbortController().signal, logger: { debug() {}, info() {}, warn() {}, error() {} }, emit() {} };
      const result = await (await writeModule.createHandler()).execute(input.arguments, context, async () => ({ allow: true }));
      return result.ok ? { success: true, output: result.output } : { success: false, error: result.error };
    });
    const ports = { repo, loadMessages: () => state.messages, resolveWorkingDirectory: () => dir,
      executeTool, persistToolMessage: async (_id: string, message: Message) => { state.messages.push(message); }, now: () => 3_000 };
    expect(await resumeSurvivingParkedApproval({ requestId: 'approval', response: 'allow', now: 3_000, ports }))
      .toMatchObject({ handled: true, status: 'executed' });
    expect(readFileSync(join(dir, 'weekly.md'))).toEqual(Buffer.from(content));
    expect(state.messages.at(-1)?.toolResults?.[0]).toMatchObject({ success: true });
    await resumeSurvivingParkedApproval({ requestId: 'approval', response: 'allow', now: 3_001, ports });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('pending and voided channel items name the user request before this call, independent of later messages', () => {
    seed();
    const service = new SessionAutomationService();
    const pending = service.listParkedApprovals()[0];
    expect(pending).toMatchObject({ status: 'pending', taskTitle: '新建 weekly' });
    repo.resolve({ id: 'approval', status: 'rejected', feedback: 'Auto-rejected after restart: args_unavailable', resolvedAt: Date.now() });
    expect(service.listParkedApprovals()[0]).toMatchObject({ status: 'voided', taskTitle: pending.taskTitle });
  });

  it('other sessions keep their session title; missing call never borrows another request', () => {
    seed();
    state.title = '每周汇总';
    expect(new SessionAutomationService().listParkedApprovals()[0]).toMatchObject({ sessionTitle: '每周汇总', taskTitle: undefined });
    state.title = '[Channel] Feishu test · oc_example';
    state.messages = state.messages.filter((message) => message.role !== 'assistant');
    expect(new SessionAutomationService().listParkedApprovals()[0].taskTitle).toBeUndefined();
  });

  it.each(['channel', 'cron', 'heartbeat'])('%s: truncated Write still voids at boot', (origin) => {
    state.origin = origin;
    seed({ ...args, content: 'a'.repeat(300) });
    expect(hydrate().survived).toBe(0);
    expect(repo.getById('approval')).toMatchObject({ status: 'rejected',
      feedback: `Auto-rejected after restart: ${origin === 'channel' ? 'args_unavailable' : 'run_ended_after_restart'}` });
  });
});
