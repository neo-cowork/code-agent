import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../src/shared/contract';
import type { DatabaseService } from '../../../src/host/services/core/databaseService';
import type { SessionManager } from '../../../src/host/services/infra/sessionManager';

const state = vi.hoisted(() => {
  const webMode = process.env.CODE_AGENT_WEB_MODE;
  process.env.CODE_AGENT_WEB_MODE = 'true';
  return { webMode,
  db: undefined as DatabaseService | undefined,
  sessions: undefined as SessionManager | undefined,
};
});
vi.mock('../../../src/host/services/core/databaseService', async (importOriginal) => ({
  ...await importOriginal<object>(), getDatabase: () => state.db,
}));
vi.mock('../../../src/host/services/infra/sessionManager', async (importOriginal) => ({
  ...await importOriginal<object>(), getSessionManager: () => state.sessions,
}));
vi.mock('../../../src/host/services', () => ({ getSessionManager: () => state.sessions }));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn(), notifyTaskComplete: vi.fn() },
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, createLogger: () => logger };
});
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({ generateBashDescription: async () => null }));

vi.unmock('better-sqlite3');

import { DatabaseService as Database } from '../../../src/host/services/core/databaseService';
import { SessionManager as Sessions } from '../../../src/host/services/infra/sessionManager';
import { CronService } from '../../../src/host/cron/cronService';
import { createCronAgentSession } from '../../../src/host/cron/cronAgentSession';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { mintToolRunGrant } from '../../../src/host/permissions/toolGrantStore';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { resolveSessionDefaultModelConfig } from '../../../src/host/services/core/sessionDefaults';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getAllToolDefinitions } from '../../../src/host/tools/dispatch/toolDefinitions';
import { getPermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { getPermissionModeManager } from '../../../src/host/permissions/modes';
import { resolveToolWriteTargets } from '../../../src/host/tools/writeTargets';
import { getToolCache } from '../../../src/host/services/infra/toolCache';

afterAll(() => {
  if (state.webMode === undefined) delete process.env.CODE_AGENT_WEB_MODE;
  else process.env.CODE_AGENT_WEB_MODE = state.webMode;
});

let folder: string;
let cron: CronService;
let island: OrchestratorPermissionIsland;
let sourceId: string;

beforeEach(async () => {
  folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'schedule-write-enforcement-')));
  state.db = new Database(folder);
  await state.db.initialize();
  state.sessions = new Sessions();
  sourceId = (await state.sessions.createSession({ title: 'Daily notes', workingDirectory: folder, modelConfig: resolveSessionDefaultModelConfig() })).id;
  cron = new CronService();
  getToolCache().clear();
  island = new OrchestratorPermissionIsland({
    getSettings: () => ({ permissions: { autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [] } }) as unknown as AppSettings,
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'async_agent',
    hasApprovalUi: () => false,
    onEvent: vi.fn(),
    injectedPendingApprovalRepo: state.db.getPendingApprovalRepo(),
  });
});

afterEach(async () => {
  for (const row of state.db!.getPendingApprovalRepo().listByKindAndStatus('tool_approval', 'pending')) island.resolveParkedApproval(row.id, 'deny');
  await cron.dispose();
  await state.sessions!.dispose();
  state.db!.close();
  resetPermissionModeManager();
  rmSync(folder, { recursive: true, force: true });
});

async function job() {
  return cron.createJob({
    name: 'Morning to-do list', scheduleType: 'cron', schedule: { type: 'cron', expression: '0 8 * * *' },
    action: { type: 'agent', agentType: 'default', prompt: 'Write today’s to-do list into notes.md', context: { sourceSessionId: sourceId } },
    enabled: false,
  });
}

async function execute(jobId: string, tool = 'Write', filePath = path.join(folder, 'notes.md')) {
  const definition = cron.getJob(jobId)!;
  // Production session creation supplies both origin and unattended registration.
  const session = await createCronAgentSession(definition, definition.action);
  const executor = new ToolExecutor({ workingDirectory: folder, requestPermission: (request) => island.requestPermission(request) });
  executor.setAuditEnabled(false);
  const promise = executor.execute(tool, tool === 'Edit'
    ? { file_path: filePath, edits: [{ old_text: 'Monday', new_text: 'Tuesday' }] }
    : { file_path: filePath, content: 'Monday: review the plan\n' }, { sessionId: session.id });
  return { promise, session };
}

async function parked() {
  await vi.waitFor(() => expect(state.db!.getPendingApprovalRepo().listByKindAndStatus('tool_approval', 'pending')).toHaveLength(1));
  return state.db!.getPendingApprovalRepo().listByKindAndStatus('tool_approval', 'pending')[0];
}

describe('scheduled writes through ToolExecutor → orchestratorPermissions', () => {
  it('no grant parks before writing; plain Allow writes the file', async () => {
    const task = await job();
    const run = await execute(task.id);
    const pending = await parked();
    expect(pending.coordinatorId).toBe(run.session.id);
    expect(existsSync(path.join(folder, 'notes.md'))).toBe(false);
    expect(island.resolveParkedApproval(pending.id, 'allow')).toBe(true);
    expect((await run.promise).success).toBe(true);
    expect(readFileSync(path.join(folder, 'notes.md'), 'utf8')).toContain('Monday');
  });

  it('grant authorizes a relative Write with schedule-write-grant provenance; revoke parks again', async () => {
    const task = await job();
    await cron.grantWriteScope(task.id);
    const run = await execute(task.id, 'Write', 'notes.md');
    expect((await run.promise).success).toBe(true);
    expect(state.db!.getPermissionDecisionsBySession(run.session.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ finalOutcome: 'allow', reason: 'schedule-write-grant' }),
    ]));
    await cron.revokeWriteScope(task.id);
    const revoked = await execute(task.id, 'Edit', 'notes.md');
    const pending = await parked();
    expect(readFileSync(path.join(folder, 'notes.md'), 'utf8')).toContain('Monday');
    island.resolveParkedApproval(pending.id, 'deny');
    expect((await revoked.promise).success).toBe(false);
  });

  it('heartbeat writes cannot bypass folder consent through skill or tool grants', async () => {
    const task = await job();
    await cron.updateJob(task.id, { action: { type: 'agent', agentType: 'default', prompt: 'Write the morning plan', context: { sourceSessionId: sourceId, heartbeatTask: true } } });
    const definition = cron.getJob(task.id)!;
    const session = await createCronAgentSession(definition, definition.action);
    expect(session.origin?.kind).toBe('heartbeat');
    mintToolRunGrant(session.id, 'Write');
    const executor = new ToolExecutor({ workingDirectory: folder, requestPermission: (request) => island.requestPermission(request) });
    executor.setAuditEnabled(false);
    const run = executor.execute('Write', { file_path: 'notes.md', content: 'Morning plan\n' }, {
      sessionId: session.id, preApprovedTools: new Set(['Write']),
    });
    const pending = await parked();
    expect(existsSync(path.join(folder, 'notes.md'))).toBe(false);
    island.resolveParkedApproval(pending.id, 'deny');
    expect((await run).success).toBe(false);
  });

  it('a non-cron unattended channel session keeps its in-folder automatic approval', async () => {
    const session = await state.sessions!.createSession({
      title: 'Channel notes', workingDirectory: folder, modelConfig: resolveSessionDefaultModelConfig(), origin: { kind: 'channel', id: 'channel-notes' },
    });
    const requestPermission = vi.fn((request: Parameters<OrchestratorPermissionIsland['requestPermission']>[0]) => island.requestPermission(request));
    const executor = new ToolExecutor({ workingDirectory: folder, requestPermission });
    executor.setAuditEnabled(false);
    expect((await executor.execute('Write', { file_path: 'notes.md', content: 'Channel notes\n' }, { sessionId: session.id })).success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(readFileSync(path.join(folder, 'notes.md'), 'utf8')).toBe('Channel notes\n');
  });

  it.each(['Write', 'Edit', 'Append', 'write_file', 'edit_file', 'append_file', 'DocEdit', 'docx_generate', 'excel_generate'])('startup backfills historical %s-only scheduled writers once, including after revoke', async (toolName) => {
    const old = await job();
    const fresh = await job();
    const historical = await createCronAgentSession(old, old.action);
    state.db!.appendPermissionDecision({
      sessionId: historical.id, toolName, summary: 'notes.md', finalOutcome: 'allow',
      historyOutcome: 'auto-approve', reason: '写入项目目录内', durationMs: 0, recordedAt: Date.now(),
    });
    await cron.initialize();
    expect(cron.getJob(old.id)?.metadata?.writeGrantRoot).toBe(folder);
    expect(cron.getJob(fresh.id)?.metadata?.writeGrantRoot).toBeUndefined();
    await cron.revokeWriteScope(old.id);
    await cron.dispose();
    cron = new CronService();
    await cron.initialize();
    expect(cron.getJob(old.id)?.metadata?.writeGrantRoot).toBeUndefined();
    expect(state.db!.getDb()!.prepare('SELECT COUNT(*) AS count FROM cron_write_grant_migration').get()).toEqual({ count: 1 });
  });
});

describe('scheduled Office writes (path from file_path | path | output_path) obey the same grant', () => {
  const cases: Array<{ tool: string; ext: string; params: (target: string) => Record<string, unknown> }> = [
    { tool: 'docx_generate', ext: 'report.docx', params: (target) => ({ output_path: target, title: 'Daily report', content: '# Daily report\n\nAll good.\n' }) },
    { tool: 'excel_generate', ext: 'report.xlsx', params: (target) => ({ output_path: target, title: 'Daily report', data: 'name,count\nnotes,1' }) },
    { tool: 'DocEdit', ext: 'report.xlsx', params: (target) => ({ file_path: target, operations: [{ action: 'set_cell', cell: 'A1', value: 1 }] }) },
  ];

  async function run(taskId: string, tool: string, params: Record<string, unknown>) {
    const definition = cron.getJob(taskId)!;
    const session = await createCronAgentSession(definition, definition.action);
    const executor = new ToolExecutor({ workingDirectory: folder, requestPermission: (request) => island.requestPermission(request) });
    executor.setAuditEnabled(false);
    return { promise: executor.execute(tool, params, { sessionId: session.id }), session };
  }

  it.each(cases)('$tool: no grant parks with nothing written; grant approves via schedule-write-grant; revoke parks again', async ({ tool, ext, params }) => {
    const target = path.join(folder, ext);
    const task = await job();

    const first = await run(task.id, tool, params(target));
    const pending = await parked();
    expect(pending.coordinatorId).toBe(first.session.id);
    expect(existsSync(target)).toBe(false);
    island.resolveParkedApproval(pending.id, 'deny');
    await first.promise;

    await cron.grantWriteScope(task.id);
    const granted = await run(task.id, tool, params(target));
    await granted.promise;
    expect(state.db!.getPermissionDecisionsBySession(granted.session.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ finalOutcome: 'allow', reason: 'schedule-write-grant' }),
    ]));
    expect(state.db!.getPendingApprovalRepo().listByKindAndStatus('tool_approval', 'pending')).toHaveLength(0);
    if (tool !== 'DocEdit') expect(existsSync(target)).toBe(true);

    await cron.revokeWriteScope(task.id);
    const revoked = await run(task.id, tool, params(path.join(folder, `again-${ext}`)));
    const again = await parked();
    expect(again.coordinatorId).toBe(revoked.session.id);
    expect(existsSync(path.join(folder, `again-${ext}`))).toBe(false);
    island.resolveParkedApproval(again.id, 'deny');
    await revoked.promise;
  });
});

// Iterate production registrations, not a second list of guarded tool names. The
// attended classifier identifies W1's file class; every such tool must park, even
// with skill/tool grants and bypassPermissions trying to shortcut confirmation.
it('registry-wide: no workspace-file classifier approval can bypass scheduled consent', async () => {
  getProtocolRegistry();
  const classifier = getPermissionClassifier({ enableLlm: false });
  const task = await job();
  const definition = cron.getJob(task.id)!;
  const session = await createCronAgentSession(definition, definition.action);
  const audit: string[] = [];
  let checked = 0;
  for (const tool of getAllToolDefinitions()) {
    getPermissionModeManager().setSessionMode(session.id, 'default');
    const params: Record<string, unknown> = {
      file_path: path.join(folder, 'report.md'), path: path.join(folder, 'report.md'),
      output_path: path.join(folder, 'report.docx'), notebook_path: path.join(folder, 'report.ipynb'),
      file: path.join(folder, 'report.html'), filename: 'report.md',
      new_source: 'Meeting notes', line: 1, userIntent: 'Update the meeting heading', action: 'write',
      code: 'print(1)', script: 'print(1)', slides: [], prompt: 'Daily report', topic: 'Daily sales report',
      content: 'Daily report', title: 'Daily sales', data: 'item,sales\nnotes,1',
      edits: [{ old_text: 'Monday', new_text: 'Tuesday' }],
      operations: [{ action: 'set_cell', cell: 'A1', value: 1 }],
      command: 'printf meeting > notes.md', input: 'printf meeting > notes.md',
    };
    for (const descriptor of tool.pathAuthority ?? []) {
      if (descriptor.kind !== 'path') continue;
      params[descriptor.pathParameter] = path.join(folder, 'report.md');
      if (descriptor.whenParameter) params[descriptor.whenParameter] = descriptor.whenValues?.[0];
    }
    const context = { workingDirectory: folder, workspaceRoot: folder, permissionLevel: tool.permissionLevel, toolDefinition: tool };
    const attended = await classifier.classify(tool.name, params, context);
    const scheduled = await classifier.classify(tool.name, params, { ...context, sessionId: session.id });
    const assessment = resolveToolWriteTargets({ definition: tool, params, workingDirectory: folder });
    const workspaceFile = attended.decision === 'approve' && attended.reason === '写入项目目录内';
    const candidate = tool.permissionLevel !== 'read' || tool.pathAuthority?.length || workspaceFile;
    if (!candidate) continue;
    if (!workspaceFile) {
      let proof = 'report-only; outside W1 file class; not dispatched';
      if (tool.requiresPermission && scheduled.decision === 'ask'
        && ['notebook_edit', 'visual_edit', 'ppt_edit', 'ppt_generate', 'Bash'].includes(tool.name)) {
        getPermissionModeManager().setSessionMode(session.id, 'default');
        const executor = new ToolExecutor({ workingDirectory: folder, requestPermission: (request) => island.requestPermission(request) });
        executor.setAuditEnabled(false);
        let settled: Awaited<ReturnType<ToolExecutor['execute']>> | undefined;
        process.stdout.write(`REPORT-ONLY EXECUTOR ${tool.name}\n`);
        const promise = executor.execute(tool.name, params, { sessionId: session.id }).then((result) => { settled = result; return result; });
        await vi.waitFor(() => {
          expect(Boolean(settled) || state.db!.getPendingApprovalRepo().listByKindAndStatus('tool_approval', 'pending').length > 0).toBe(true);
        }, { timeout: 5000 });
        const row = state.db!.getPendingApprovalRepo().listByKindAndStatus('tool_approval', 'pending')[0];
        if (row) {
          proof = 'report-only; parks: ToolExecutor + SQLite pending row';
          island.resolveParkedApproval(row.id, 'deny');
        } else {
          proof = `report-only; executor settled before park: success=${settled?.success}; ${settled?.error ?? ''}`;
        }
        await promise;
      }
      audit.push(`${tool.name} | ${tool.permissionLevel} | ${JSON.stringify(tool.pathAuthority ?? [])} | ${scheduled.decision} | ${proof}`);
      continue;
    }
    checked += 1;
    // The same file class with a new descriptor key must still require consent.
    const renamed = await classifier.classify(tool.name, { destination: path.join(folder, 'renamed.md') }, {
      ...context, sessionId: session.id,
      toolDefinition: { ...tool, pathAuthority: [{ kind: 'path', pathParameter: 'destination', mutation: 'overwrite' }] },
    });
    expect(renamed.decision, `${tool.name}: new descriptor key`).toBe('ask');
    expect(renamed.scheduleWriteTargets, tool.name).toEqual([path.join(folder, 'renamed.md')]);
    expect(scheduled.decision, tool.name).toBe('ask');
    expect(scheduled.scheduleWriteTargets, tool.name).toEqual(assessment.targets);
    // No local handler runs: the real permission island must persist the park first.
    mintToolRunGrant(session.id, tool.name);
    getPermissionModeManager().setSessionMode(session.id, 'bypassPermissions', true);
    const executor = new ToolExecutor({ workingDirectory: folder, requestPermission: (request) => island.requestPermission(request) });
    executor.setAuditEnabled(false);
    const promise = executor.execute(tool.name, params, { sessionId: session.id, preApprovedTools: new Set([tool.name]) });
    const row = await parked();
    expect(JSON.parse(row.payloadJson).tool, tool.name).toBe(tool.name);
    expect(existsSync(path.join(folder, 'report.md')), tool.name).toBe(false);
    island.resolveParkedApproval(row.id, 'deny');
    expect((await promise).success, tool.name).toBe(false);
    audit.push(`${tool.name} | ${tool.permissionLevel} | ${JSON.stringify(tool.pathAuthority ?? [])} | ask | parks: ToolExecutor + SQLite pending row; denied before handler`);
  }
  expect(checked).toBeGreaterThan(0);
  process.stdout.write('REGISTRY AUDIT (tool | permission | descriptors | no-grant classification | executor proof)\n' + audit.join('\n') + '\n');
  process.stdout.write(`REGISTRY GUARDED COUNT ${checked}\n`);
}, 120000);

// Write-level tools outside the nine named file tools (pdf/chart/Excel automation) were
// once exempt from the grant: skill pre-approval + tool-run grant + bypass mode must still park.
it.each([
  { tool: 'pdf_generate', params: (t: string) => ({ output_path: t, title: 'Daily', content: '# Daily\n' }), ext: 'daily.pdf' },
  { tool: 'chart_generate', params: (t: string) => ({ output_path: t, type: 'bar', labels: ['a'], datasets: [{ label: 'x', data: [1] }] }), ext: 'daily.png' },
  { tool: 'ExcelAutomate', params: (t: string) => ({ action: 'edit', file_path: t, operations: [{ action: 'set_cell', cell: 'A1', value: 1 }] }), ext: 'daily.xlsx' },
])('$tool: pre-approval, tool-run grant and bypass mode cannot skip the scheduled write grant', async ({ tool, params, ext }) => {
  getProtocolRegistry();
  const task = await job();
  const definition = cron.getJob(task.id)!;
  const session = await createCronAgentSession(definition, definition.action);
  mintToolRunGrant(session.id, tool);
  getPermissionModeManager().setSessionMode(session.id, 'bypassPermissions', true);
  const target = path.join(folder, ext);
  const executor = new ToolExecutor({ workingDirectory: folder, requestPermission: (request) => island.requestPermission(request) });
  executor.setAuditEnabled(false);
  const promise = executor.execute(tool, params(target), { sessionId: session.id, preApprovedTools: new Set([tool]) });
  const row = await parked();
  expect(JSON.parse(row.payloadJson).tool).toBe(tool);
  expect(existsSync(target)).toBe(false);
  island.resolveParkedApproval(row.id, 'deny');
  expect((await promise).success).toBe(false);
});
