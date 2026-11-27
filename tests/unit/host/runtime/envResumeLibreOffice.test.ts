// Evidence class: hermetic-protocol + fault-injection.
// N-ENV-ASSIST-S5-RUNTIME: a Bash command that runs soffice while LibreOffice is missing goes through the production
// shell tool entry (the Bash module → createEvalSafeShellEnv → applyManagedLibreOffice), parks the run in
// ToolExecutionEngine, shows one card, and finishes by itself once the install lands. Real ToolExecutor / engine /
// durable kernel / continuation / waiter / env-assist routes; the real installer with its injectable
// probe / download / runCommand options (no network, no disk image); real SQLite; fake timers where no child runs.
import crypto from 'crypto';
import fs from 'fs';
import http from 'node:http';
import os from 'node:os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/shared/contract';
import type { EnvAssistNotice } from '../../../../src/shared/contract/envAssist';
import { getLibreOfficeState } from '../../../../src/host/runtime/libreOffice/state';
import type { EnsureLibreOfficeOptions } from '../../../../src/host/runtime/libreOffice/types';

vi.unmock('better-sqlite3');

/** The installer's outer world: reachability, a download the test can hold and feed, the two disk commands. */
const world = vi.hoisted(() => ({
  online: true, hold: false, downloads: 0, probes: 0,
  release: undefined as (() => void) | undefined,
  report: undefined as ((transferred: number, total: number) => void) | undefined,
}));
vi.mock('../../../../src/host/runtime/libreOffice/ensure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/runtime/libreOffice/ensure')>();
  const fakeImage = Buffer.from('fake LibreOffice disk image (hermetic test)');
  return {
    ...actual,
    // The production hook calls ensureLibreOffice() with no options: merge the injectable ones in and run the real installer.
    ensureLibreOffice: (options: EnsureLibreOfficeOptions = {}) => actual.ensureLibreOffice({
      probe: async (url) => { world.probes++; return { url, ok: world.online, ttfbMs: world.online ? 5 : 3000 }; },
      download: async (_url, destination, totalBytes, onProgress) => {
        world.downloads++;
        world.report = (transferred) => onProgress(transferred, totalBytes);
        onProgress(Math.round(totalBytes / 10), totalBytes);
        if (world.hold) await new Promise<void>((resolve) => { world.release = resolve; });
        fs.writeFileSync(destination, fakeImage);
        onProgress(totalBytes, totalBytes);
      },
      runCommand: async (file: string, args: string[]) => {
        // ditto copies LibreOffice.app out of the mounted image: lay down a soffice that records its calls and "converts".
        if (file !== 'ditto') return;
        const macos = path.join(args[1], 'Contents', 'MacOS');
        fs.mkdirSync(macos, { recursive: true });
        // The real command runs inside the Bash sandbox: only the temp directory and the workspace are writable there.
        const log = path.join(os.tmpdir(), `neo-test-soffice-${process.pid}.log`);
        process.env.NEO_TEST_SOFFICE_LOG = log;
        fs.writeFileSync(path.join(macos, 'soffice'), [
          '#!/bin/sh',
          `printf 'ran %s | office=%s | socket=%s\\n' "$0" "\${UserInstallation:-}" "\${OSL_SOCKET_PATH:-}" >> '${log}'`,
          'out=""; input=""',
          'while [ $# -gt 0 ]; do case "$1" in --outdir) out="$2"; shift 2 ;; -*) shift ;; *) input="$1"; shift ;; esac; done',
          'mkdir -p "$out"',
          'base=$(basename "$input"); base="${base%.*}"',
          `printf '%%PDF-1.4 heresian\\n' > "$out/$base.pdf"`,
          'echo "convert $input -> $out/$base.pdf"',
        ].join('\n'), { mode: 0o755 });
      },
      ...options,
    }),
  };
});

const store = vi.hoisted(() => ({
  db: {} as Record<string, unknown>, logs: [] as Array<[string, unknown]>,
  /** Every env_assist_notice broadcast, in order: the card's live history. */
  events: [] as unknown[],
}));
vi.mock('../../../../src/host/services/core/databaseService', () => ({ getDatabase: () => store.db }));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async (sessionId: string) => (store.db.getMessages as (id: string) => Message[])?.(sessionId) ?? [],
    addMessageToSession: async (sessionId: string, message: Message) => (store.db.addMessage as (id: string, m: Message) => void)?.(sessionId, message),
  }),
}));
vi.mock('../../../../src/host/services/agentEngine/agentEngineEventSink', () => ({ emitExternalAgentEvent: (_sessionId: string, event: unknown) => { store.events.push(event); } }));
vi.mock('../../../../src/host/permissions/envAssist/settingsPane', () => ({ canOpenEnvSettings: () => false, openEnvSettings: vi.fn(async () => false) }));
vi.mock('../../../../src/host/tools/shell/dynamicDescription', () => ({ generateBashDescription: async () => null }));
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/services/infra/logger')>(),
  createLogger: (name: string) => ({
    debug: vi.fn(), info: (...args: unknown[]) => { store.logs.push([`${name} ${String(args[0])}`, args[1] ?? null]); },
    error: vi.fn(),
    warn: (...args: unknown[]) => { store.logs.push([`${name} ${String(args[0])}`, args[1] ?? null]); },
  }),
}));

import Database from 'better-sqlite3';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../../src/host/services/core/database/migrations';
import { applyIndexes } from '../../../../src/host/services/core/database/indexes';
import { SessionRepository } from '../../../../src/host/services/core/repositories/SessionRepository';
import { ToolExecutionEventRepository } from '../../../../src/host/services/core/repositories/ToolExecutionEventRepository';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { getApplicationRunRegistry } from '../../../../src/host/app/applicationRunRegistry';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { finalizeOrParkDurableRun } from '../../../../src/host/agent/orchestrator/durableRunTerminal';
import { buildForArch } from '../../../../src/host/runtime/libreOffice/constants';
import { clearInflight, clearInstallPercent, forgetError } from '../../../../src/host/runtime/libreOffice/state';
import { resolveLibreOfficeRoot } from '../../../../src/host/runtime/libreOffice/layout';
import { getProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';
import { setToolLedgerSink } from '../../../../src/host/tools/toolLedgerSink';
import { ToolExecutor } from '../../../../src/host/tools/toolExecutor';
import { envResumeProbeFactory, registerEnvAssistHandlers } from '../../../../src/host/ipc/envAssist.ipc';
import { ipcHost, type HandlerFn } from '../../../../src/host/platform';
import { registerAgentContinueRoute } from '../../../../src/web/routes/registerAgentContinueRoute';
import { clearEnvResumeWaiter, registerEnvResumeContinuer } from '../../../../src/host/runtime/envResumeWaiter';
import { makeEngine } from './envResumeContext';

const out = (label: string, value: unknown) => process.stdout.write(`${label} ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sessionId = 'lo-session', runId = 'lo-run', sourceId = 'lo-source', toolCallId = 'lo-call', secondCallId = 'lo-call-2';
const COMMAND = 'soffice --headless --convert-to pdf --outdir out deck.pptx';
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const build = buildForArch();
const pinnedSha256 = build.sha256;

let db: Database.Database;
let workspace = '';
let dataDir = '';
let sofficeLog = '';
let sessions: SessionRepository;
let events: ToolExecutionEventRepository;
let registry: ReturnType<typeof getApplicationRunRegistry>;
let resumedTurns: number;
let bashExecutions: number;

const messages = () => sessions.getMessages(sessionId);
const cardRows = () => db.prepare("SELECT id, metadata FROM messages WHERE id LIKE 'env-assist:%' ORDER BY rowid").all() as Array<{ id: string; metadata: string }>;
const cards = () => cardRows().map((row) => ({ id: row.id, ...JSON.parse(row.metadata).envAssist as Record<string, unknown> }));
const toolResults = () => messages().filter((m) => m.role === 'tool').flatMap((m) => m.toolResults ?? []);
const durableStatus = () => (db.prepare('SELECT status FROM durable_runs WHERE run_id = ?').get(runId) as { status?: string } | undefined)?.status;
const logCount = (needle: string) => store.logs.filter(([text]) => text.includes(needle)).length;

/** The model's next turn: it reads the recorded "not run" receipt and issues the same command once, through the production executor. */
async function modelReissues(execute: ToolExecutor['execute']): Promise<void> {
  sessions.updateSession(sessionId, { status: 'running' });
  const handle = registry.adoptRecoveredRun({ runId, sessionId, workspace, cwd: workspace });
  const receipt = toolResults().find((result) => result.toolCallId === toolCallId)?.error ?? '';
  sessions.addMessage(sessionId, { id: 'lo-assistant-2', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [{ id: secondCallId, name: 'Bash', arguments: { command: COMMAND } }] });
  const again = await execute('Bash', { command: COMMAND }, { runId, sessionId, sourceMessageId: sourceId, currentToolCallId: secondCallId });
  sessions.addMessage(sessionId, { id: 'lo-tool-2', role: 'tool', content: '', timestamp: Date.now(), toolResults: [{ toolCallId: secondCallId, success: again.success, output: again.output, error: again.error }] });
  out('MODEL_TURN', { receipt: receipt.slice(0, 60), reissued: { success: again.success, output: again.output?.slice(0, 160), error: again.error?.slice(0, 160) } });
  await finalizeOrParkDurableRun({ registry, runId, handle, sessionId, completed: again.success });
  registry.unregister(runId, handle);
  sessions.updateSession(sessionId, { status: 'idle' });
  resumedTurns++;
}

async function setup(): Promise<{ park: () => Promise<void>; execute: ToolExecutor['execute']; tasks: unknown }> {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'env-resume-lo-')));
  dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'env-resume-lo-data-')));
  sofficeLog = path.join(os.tmpdir(), `neo-test-soffice-${process.pid}.log`);
  fs.rmSync(sofficeLog, { force: true });
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
  vi.stubEnv('CODE_AGENT_LIBREOFFICE_MANAGED_ONLY', '1');
  vi.stubEnv('CODE_AGENT_NO_RUNTIME_AUTOINSTALL', '0');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  fs.writeFileSync(path.join(workspace, 'deck.pptx'), 'PK\u0003\u0004 heresian deck');
  // The real installer verifies the image against the pinned sha256: pin it to this hermetic image for the test only.
  build.sha256 = crypto.createHash('sha256').update('fake LibreOffice disk image (hermetic test)').digest('hex');

  db = new Database(':memory:');
  applySchema(db); applySessionsMigrations(db); applyIndexes(db);
  sessions = new SessionRepository(db);
  events = new ToolExecutionEventRepository(db);
  const repository = new DurableRunRepository(db); repository.migrate();
  registry = getApplicationRunRegistry(); registry.clear();
  registry.configureDurableKernel(new DurableRunKernel({ stores: repository, ownerId: 'lo-host', processInstanceId: `lo-process-${process.pid}`, leaseDurationMs: 120_000 }));
  resumedTurns = 0; bashExecutions = 0;
  world.online = true; world.hold = true; world.downloads = 0; world.probes = 0; world.release = undefined; world.report = undefined;
  store.logs.length = 0; store.events.length = 0;
  store.db = {
    addMessage: (id: string, message: Message) => upsert(message),
    getMessages: () => messages(),
    getToolExecutionsBySession: (id: string) => events.getBySession(id),
    appendToolExecutionComplete: (input: Parameters<ToolExecutionEventRepository['appendComplete']>[0]) => events.appendComplete(input),
  };
  setToolLedgerSink({
    appendToolExecutionBegin: (input) => events.appendBegin(input),
    appendToolExecutionComplete: (input) => events.appendComplete(input),
    appendPermissionDecision: () => {},
  });
  const makeExecutor = () => {
    const instance = new ToolExecutor({ workingDirectory: workspace, requestPermission: async (request) => { out('APPROVAL_ASKED', request.tool); return true; } });
    instance.setAuditEnabled(false);
    return instance;
  };
  const execute: ToolExecutor['execute'] = async (...args) => { bashExecutions++; return makeExecutor().execute(...args); };
  const tasks = {
    getSessionState: () => ({ status: 'idle' }),
    resumeExistingDurableRun: async (_session: string, resumedId: string) => {
      if (resumedId !== runId) throw new Error('run identity changed');
      await modelReissues(execute);
    },
  };
  sessions.createSessionWithId(sessionId, { title: '把下载里的 PPT 转成 PDF', modelConfig: { provider: 'openai', model: 'fixture' }, workingDirectory: workspace });
  sessions.addMessage(sessionId, { id: sourceId, role: 'user', content: 'convert the PPT files in my Downloads folder to PDF', timestamp: 1 });
  sessions.addMessage(sessionId, { id: 'lo-assistant', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: toolCallId, name: 'Bash', arguments: { command: COMMAND } }] });
  registerAgentContinueRoute({ post: () => {} } as never, registry, () => tasks as never, async () => messages(), envResumeProbeFactory);
  return {
    execute, tasks,
    park: async () => {
      const handle = await registry.startDurable({ runId, sessionId, workspace, cwd: workspace });
      const { ctx, engine } = makeEngine(execute as never);
      Object.assign(ctx, { workingDirectory: workspace, runId, sessionId, messages: messages() });
      const emitted: Array<{ type?: string; data?: unknown }> = [];
      Object.assign(ctx, { onEvent: (event: { type?: string; data?: unknown }) => { emitted.push(event); if (event.type === 'env_assist_notice') store.events.push(event); } });
      await engine.executeToolsWithHooks([{ id: toolCallId, name: 'Bash', arguments: { command: COMMAND } }]);
      if (!ctx.control.isCancelled) throw new Error(`Engine did not park: ${JSON.stringify(emitted)} ${JSON.stringify(toolResults())}`);
      await finalizeOrParkDurableRun({ registry, runId, handle, sessionId, completed: false, cancelled: ctx.control.isCancelled });
      out('PARK_ENVELOPE', db.prepare('SELECT envelope_json FROM durable_runs').all());
      return emitted;
    },
  };
}

function upsert(message: Message): void {
  try { sessions.addMessage(sessionId, message); } catch { sessions.updateMessage(message.id, message, sessionId); }
}

const settleUntil = async (predicate: () => boolean | undefined, timeoutMs = 20_000) => {
  await vi.waitFor(() => expect(predicate() ?? false).toBe(true), { timeout: timeoutMs, interval: 50 });
};
const logsOf = (needle: string) => store.logs.filter(([text]) => text.includes(needle)).map(([text, data]) => `${text} ${JSON.stringify(data)}`);

beforeEach(() => { getProtocolRegistry(); });
afterEach(() => {
  clearEnvResumeWaiter(runId);
  registerEnvResumeContinuer(null);
  world.release?.();
  clearInflight(resolveLibreOfficeRoot()); clearInstallPercent(resolveLibreOfficeRoot()); forgetError(resolveLibreOfficeRoot());
  build.sha256 = pinnedSha256;
  vi.unstubAllEnvs(); vi.useRealTimers();
  Object.defineProperty(process, 'platform', platformDescriptor);
  process.env.CODE_AGENT_NO_RUNTIME_AUTOINSTALL = '1';
  registry?.clear();
  try { db?.close(); } catch { /* not opened */ }
  for (const dir of [workspace, dataDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** Card notices as open windows received them (the initial park notice plus every later broadcast, in order). */
const liveCards = () => store.events.map((event) => (event as { data?: EnvAssistNotice }).data).filter((data): data is EnvAssistNotice => Boolean(data?.phase))
  .map((notice) => ({ id: notice.id, phase: notice.phase, percent: notice.progress?.percent }));
const pdfText = () => fs.readFileSync(path.join(workspace, 'out', 'deck.pdf'), 'utf8');
const sofficeRuns = () => fs.existsSync(sofficeLog) ? fs.readFileSync(sofficeLog, 'utf8').trim().split('\n') : [];

/** Fixture-only time warp (same trick as tests/fixtures/envResumeKillChild.ts): delays ≥ 100 s run 100× faster. */
function warpLongTimeouts<T>(run: () => Promise<T>): Promise<T> {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
    realSetTimeout(handler, typeof timeout === 'number' && timeout >= 100_000 ? timeout / 100 : timeout, ...args)) as typeof globalThis.setTimeout;
  return run().finally(() => { globalThis.setTimeout = realSetTimeout as typeof globalThis.setTimeout; });
}

/** Entry (a) from ADR-090 owner decision B: the user comes back to the session through the real REST sessions router. */
async function returnViaRest(): Promise<void> {
  const { default: express } = await import('express');
  const { createSessionsRouter } = await import('../../../../src/web/routes/sessions');
  const deps = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tryGetSessionManager: async () => ({ restoreSession: async () => ({ id: sessionId, title: '把下载里的 PPT 转成 PDF', workingDirectory: workspace, createdAt: 1, updatedAt: 1, messages: messages() }) }),
    getSupabaseForSession: async () => null,
  } as unknown as Parameters<typeof createSessionsRouter>[0];
  const app = express();
  app.use('/api', createSessionsRouter(deps));
  const server = await new Promise<http.Server>((resolve) => { const next = app.listen(0, '127.0.0.1', () => resolve(next)); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP test server address');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${sessionId}`);
    out('ENTRY_REST', { status: response.status });
  } finally { server.close(); }
}

/** The production env-assist domain routes, driven the way the renderer's invokeDomain drives them. */
function envAssistRoutes(notices: () => EnvAssistNotice[]) {
  let handler: HandlerFn | undefined;
  vi.spyOn(ipcHost, 'handle').mockImplementation((_c, fn) => { handler = fn; });
  registerEnvAssistHandlers({ available: () => false, open: vi.fn(async () => false), findNotice: async (id) => notices().find((n) => n.id === id) });
  return (action: string, payload?: unknown) => handler!({} as never, { action, payload }) as Promise<{ data?: Record<string, unknown> }>;
}

describe('② a Bash command that needs LibreOffice parks the run and shows one card', () => {
  it('the shell hook refuses the command, the engine parks (runtime_missing / libreoffice), nothing ran, card is fixing', async () => {
    const f = await setup();
    const emitted = await f.park();
    const envelope = await registry.getDurableEnvelope(runId);
    out('PARKED', { status: envelope?.status, interruptCause: envelope?.interruptCause, envBlocked: envelope?.envBlocked, pending: envelope?.pendingOperations?.map((op) => `${op.operationId}:${op.status}`) });
    expect(envelope).toMatchObject({ status: 'waiting', interruptCause: 'env_blocked', envBlocked: { class: 'runtime_missing', target: 'libreoffice', toolCallId } });
    expect(toolResults()).toHaveLength(0);
    expect(emitted.some((event) => event.type === 'error' || event.type === 'tool_call_end')).toBe(false);
    expect(sofficeRuns()).toEqual([]);
    expect(world.downloads).toBe(1);
    expect(cards()).toHaveLength(1);
    out('CARD_FIRST', cards()[0]);
    expect(cards()[0]).toMatchObject({ id: `${runId}|runtime_missing|libreoffice`, class: 'runtime_missing', phase: 'fixing', parkedToolCallId: toolCallId, target: { id: 'libreoffice', labelKey: 'env.target.libreoffice' } });
    expect((await registry.getDurableEnvelope(runId))?.pendingOperations?.[0]).toMatchObject({ operationId: `tool:${toolCallId}`, status: 'dispatched', sideEffect: true });
  });
});

describe('③ the card follows the install in place and the run finishes by itself', () => {
  it('percent grows under one id → resolved; the held call gets a plain not-run receipt; the re-issued command converts through the PATH tail', async () => {
    const f = await setup();
    await f.park();
    const total = build.bytes;
    world.report!(Math.round(total * 0.375)); // 10 + 30 = 40%
    await settleUntil(() => cards()[0]?.progress && (cards()[0].progress as { percent: number }).percent === 40);
    world.report!(Math.round(total * 0.75)); // 70%
    await settleUntil(() => (cards()[0].progress as { percent: number } | undefined)?.percent === 70);
    out('CARDS_MID_RUN', liveCards());
    expect(cards()).toHaveLength(1);
    world.hold = false;
    world.release!();
    await settleUntil(() => resumedTurns === 1 && durableStatus() === 'completed');

    const history = liveCards();
    const percents = history.filter((card) => card.phase === 'fixing').map((card) => card.percent ?? 0);
    out('CARD_HISTORY', history);
    expect(new Set(history.map((card) => card.id)).size).toBe(1);
    expect(percents.length).toBeGreaterThan(2);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(history.at(-1)?.phase).toBe('resolved');
    expect(cards()[0]).toMatchObject({ phase: 'resolved', doneKey: 'env.done.libreoffice' });
    expect(cards()[0]!.action).toBeUndefined();

    const parked = toolResults().find((result) => result.toolCallId === toolCallId)!;
    out('PARKED_RECEIPT', parked.error);
    expect(parked.success).toBe(false);
    expect(parked.error).toContain('not run: the component this command needs was still being prepared');
    expect(parked.error).toContain('nothing was executed');
    expect(parked.error).toContain('It is ready now');
    expect(parked.error).not.toMatch(/crashed|cancelled before/);
    const again = toolResults().find((result) => result.toolCallId === secondCallId)!;
    out('REISSUED_RESULT', { success: again.success, output: again.output });
    expect(again.success).toBe(true);
    expect(pdfText()).toContain('%PDF-1.4');
    // The command said plain `soffice`; the managed copy sits outside every PATH entry of this test machine:
    // it was found through the directory the hook appended to the end of the child PATH.
    const managedSoffice = path.join(resolveLibreOfficeRoot(), 'LibreOffice.app', 'Contents', 'MacOS', 'soffice');
    out('SOFFICE_RUNS', sofficeRuns());
    expect(sofficeRuns()).toHaveLength(1);
    expect(sofficeRuns()[0]).toContain(`ran ${managedSoffice}`);
    // …with the two variables that let LibreOffice start inside the Bash sandbox.
    expect(sofficeRuns()[0]).toMatch(/office=file:\/\/.*\/neo-libreoffice-profile \| socket=\/private\/tmp$/);
    expect(bashExecutions).toBe(2);
    expect(messages().filter((m) => m.role === 'user')).toHaveLength(1);
    expect(logCount('Environment auto-continue stopped')).toBe(0);
    out('LOGS', store.logs.map(([text, data]) => `${text} ${JSON.stringify(data)}`));
  });

  it('no hard 120 s cutoff: the wait outlives the fixed permission window while progress keeps moving', async () => {
    const f = await setup();
    await warpLongTimeouts(async () => {
      await f.park();
      // 2.6 s real = 260 s warped (> ENV_RESUME_TIMEOUT_MS, < ENV_RESUME_RUNTIME_STALL_MS), progress every 300 ms.
      for (let step = 1; step <= 8; step++) {
        world.report!(Math.round(build.bytes * (0.05 * step)));
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(cards()[0]?.phase).toBe('fixing');
      expect(logCount('Environment auto-continue stopped')).toBe(0);
      world.hold = false;
      world.release!();
      await settleUntil(() => resumedTurns === 1);
    });
    expect(logsOf('Environment auto-continue stopped')).toEqual([]);
    expect(sofficeRuns()).toHaveLength(1);
  });

  it('a run that cannot park (no durable run) waits in the call for the install, then tells the model to run the command again', async () => {
    const f = await setup();
    const { ctx, engine } = makeEngine(f.execute as never);
    Object.assign(ctx, { workingDirectory: workspace, runId, sessionId, messages: messages() });
    let result: Awaited<ReturnType<ToolExecutor['execute']>> | undefined;
    Object.assign(ctx, { onEvent: () => undefined, toolExecutor: { execute: (async (...args: Parameters<ToolExecutor['execute']>) => { result = await f.execute(...args); return result; }) as never } });
    let finished = false;
    const call = engine.executeToolsWithHooks([{ id: 'lo-direct', name: 'Bash', arguments: { command: COMMAND } }]).finally(() => { finished = true; });
    await settleUntil(() => cards()[0]?.phase === 'fixing');
    // The card shows progress while the call is still held; it returns only when the install lands.
    expect(finished).toBe(false);
    world.hold = false;
    world.release!();
    const [toolResult] = await call;
    out('NON_PARKABLE', { success: toolResult.success, error: toolResult.error, metadata: toolResult.metadata });
    expect(ctx.control.isCancelled).toBe(false);
    expect(result?.success).toBe(false);
    // publishEnvAssistToolNotice swaps the result for the card + guidance (the renderer drops the row that carries the card).
    expect(result?.metadata).toMatchObject({ envAssist: { class: 'runtime_missing', phase: 'fixing' } });
    expect((result?.metadata?.envAssist as EnvAssistNotice | undefined)?.parkedToolCallId).toBeUndefined();
    expect(String(result?.error)).toContain('Model guidance (not user copy)');
    // The call returned only after the install landed: the model is told it is ready and the command did not run.
    expect(String(result?.error)).toContain('ready now');
    expect(String(result?.error)).not.toMatch(/ENOENT|command not found|not found|Error:/);
    expect(getLibreOfficeState().phase).toBe('installed');
    expect(sofficeRuns()).toHaveLength(0);
    expect(cards()[0]).toMatchObject({ class: 'runtime_missing' });
    expect(cards()[0]!.parkedToolCallId).toBeUndefined();
    expect((await registry.getDurableEnvelope(runId))?.status).toBeUndefined();
  });
});

describe('④ offline: the card asks with one retry button; Retry install restarts and the run finishes', () => {
  it('probe fails → needs_user(retry) and the waiter stops without resuming; envAssist.act recheck → fixing → resolved → PDF', async () => {
    const f = await setup();
    world.online = false; world.hold = false;
    await f.park();
    await settleUntil(() => cards()[0]?.phase === 'needs_user'
      && logsOf('Environment auto-continue stopped').some((line) => line.includes('"runtime_install_failed"')));
    const failed = cards()[0] as unknown as EnvAssistNotice;
    out('CARD_FAILED', failed);
    expect(failed).toMatchObject({ phase: 'needs_user', sentenceKey: 'env.sentence.libreofficeOffline', action: { kind: 'recheck', labelKey: 'env.retry.libreoffice' } });
    expect(failed.progress).toBeUndefined();
    out('WAITER_STOPPED', logsOf('Environment auto-continue stopped'));
    expect(logsOf('Environment auto-continue stopped').some((line) => line.includes('"runtime_install_failed"'))).toBe(true);
    expect(resumedTurns).toBe(0);
    expect((await registry.getDurableEnvelope(runId))?.status).toBe('waiting');

    const call = envAssistRoutes(() => cards() as unknown as EnvAssistNotice[]);
    // Host accepts only the current notice's own action.
    const probesBefore = world.probes;
    expect(await call('act', { noticeId: 'no-such-card', actionKind: 'recheck' })).toMatchObject({ data: { status: 'rejected' } });
    expect(await call('act', { noticeId: failed.id, actionKind: 'open_settings_pane', payload: { pane: 'automation' } })).toMatchObject({ data: { status: 'rejected' } });
    expect(world.probes).toBe(probesBefore);
    expect(world.downloads).toBe(0);
    // The passive re-read a card does on mount/focus never starts anything.
    expect(await call('recheck', { noticeId: failed.id })).toMatchObject({ data: { status: 'checked', notice: { phase: 'needs_user' } } });
    expect(world.probes).toBe(probesBefore);
    expect(world.downloads).toBe(0);

    world.online = true;
    const retry = await call('act', { noticeId: failed.id, actionKind: 'recheck' });
    out('RETRY_RESULT', retry);
    expect(retry).toMatchObject({ data: { status: 'checked', notice: { phase: 'fixing' } } });
    await settleUntil(() => resumedTurns === 1);
    const history = liveCards();
    out('CARD_HISTORY_OFFLINE', history);
    expect(history.map((card) => card.phase)).toContain('needs_user');
    expect(history.at(-1)?.phase).toBe('resolved');
    expect(new Set(history.map((card) => card.id)).size).toBe(1);
    expect(world.downloads).toBe(1);
    expect(pdfText()).toContain('%PDF-1.4');
    expect(durableStatus()).toBe('completed');
    // A replayed click after the card resolved is refused: it is no longer asking.
    expect(await call('act', { noticeId: failed.id, actionKind: 'recheck' })).toMatchObject({ data: { status: 'rejected' } });
  });
});

describe('⑤ no progress for the stall window: the wait ends honestly and the card asks', () => {
  it('a download that stops moving → waiter stops (stalled), card needs_user(retry), run stays parked and continuable', async () => {
    const f = await setup();
    await warpLongTimeouts(async () => {
      await f.park();
      await settleUntil(() => cards()[0]?.phase === 'needs_user'
        && logsOf('Environment auto-continue stopped').some((line) => line.includes('"stalled"')), 15_000);
    });
    out('CARD_STALLED', cards()[0]);
    expect(cards()[0]).toMatchObject({ phase: 'needs_user', sentenceKey: 'env.sentence.libreofficeStalled', action: { kind: 'recheck' } });
    out('WAITER_STOPPED_STALLED', logsOf('Environment auto-continue stopped'));
    expect(logsOf('Environment auto-continue stopped').some((line) => line.includes('"stalled"'))).toBe(true);
    expect(resumedTurns).toBe(0);
    expect((await registry.getDurableEnvelope(runId))?.status).toBe('waiting');
  });
});

describe('⑥ the install died with the process: the park survives and coming back to the session restarts everything', () => {
  it('in-memory install state lost, card left at "preparing 40%": REST session return re-arms the waiter, the install restarts, the run finishes', async () => {
    const f = await setup();
    await f.park();
    world.report!(Math.round(build.bytes * 0.375));
    await settleUntil(() => (cards()[0].progress as { percent: number } | undefined)?.percent === 40);
    // Process death: the waiter loop, single-flight install, and progress only lived in memory.
    clearEnvResumeWaiter(runId);
    registerEnvResumeContinuer(null);
    clearInflight(resolveLibreOfficeRoot()); clearInstallPercent(resolveLibreOfficeRoot());
    expect(getLibreOfficeState().phase).toBe('missing');
    out('A_DEATH', { card: cards()[0], downloads: world.downloads });
    expect(cards()[0]).toMatchObject({ phase: 'fixing', progress: { percent: 40 } });

    world.hold = false;
    registerAgentContinueRoute({ post: () => {} } as never, registry, () => f.tasks as never, async () => messages(), envResumeProbeFactory);
    await returnViaRest();
    await settleUntil(() => resumedTurns === 1 && durableStatus() === 'completed');
    out('LOGS_AFTER_RETURN', store.logs.map(([text, data]) => `${text} ${JSON.stringify(data)}`));
    expect(logsOf('Environment auto-continue armed on session return').some((line) => line.includes('GET /sessions/:id'))).toBe(true);
    expect(world.downloads).toBe(2);
    const history = liveCards();
    out('CARD_HISTORY_RESTART', history);
    expect(history.at(-1)?.phase).toBe('resolved');
    expect(new Set(history.map((card) => card.id)).size).toBe(1);
    expect(sofficeRuns()).toHaveLength(1);
    expect(pdfText()).toContain('%PDF-1.4');
    expect(messages().filter((m) => m.role === 'user')).toHaveLength(1);
  });
});
