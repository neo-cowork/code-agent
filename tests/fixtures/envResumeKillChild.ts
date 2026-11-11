// Run with node --import tsx; caller provides an isolated data directory.
// The recover children run with DEBUG=true so the EnvResumeWaiter INFO/WARN lines
// reach stderr (CLI mode gates info/warn at the logger instance level otherwise);
// this fixture taps stderr to keep its own invariants and replays the lines verbatim.
// Modes:
//   park            — park an env_blocked run (read tool), print READY, hold the process for SIGKILL
//   park-write      — same with the sideEffect (write) fixture tool
//   recover         — restart: startup observes only, then the user returns via entry (a) REST GET /sessions/:id
//   recover-domain  — same via entry (b) domain session load (desktop context through the shared route table)
//   recover-repeat  — entry (a) three times inside one poll interval (exactly one loop may arm)
//   recover-noentry — user never returns: green probe registered, no entry call
//   recover-timeout — user returns, probe stays red, ENV_RESUME_TIMEOUT_MS elapses (time-warped, see below)
//   recover-write   — sideEffect fixture through entry (a): write tool must not re-execute
import http from 'node:http';
import { harness } from '../unit/host/runtime/envResumeHarness';
import { registerEnvResumeContinuer } from '../../src/host/runtime/envResumeWaiter';
import { DurableRecoveryDispatcher } from '../../src/host/runtime/durableRecoveryDispatcher';

const [mode, workspace, file] = process.argv.slice(2);
if (!workspace || !file) throw new Error('mode, workspace and database are required');
const sideEffect = mode.endsWith('-write');

/** Fixture-only time warp for recover-timeout: delays >= 100s scale by 1/100 so the
 * 120s ENV_RESUME_TIMEOUT_MS deadline fires in ~1.2s real time (no production override). */
function warpLongTimeouts(): void {
  const realSetTimeout: typeof globalThis.setTimeout = globalThis.setTimeout.bind(globalThis);
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
    realSetTimeout(handler, typeof timeout === 'number' && timeout >= 100_000 ? timeout / 100 : timeout, ...args)) as typeof globalThis.setTimeout;
}

const waiterLines: string[] = [];
if (!mode.startsWith('park')) {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: Uint8Array | string, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.includes('Environment auto-continue')) waiterLines.push(text.trimEnd());
    return originalStderrWrite(chunk, ...(rest as []));
  }) as typeof process.stderr.write;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(predicate: () => T | Promise<T | undefined> | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(25);
  }
}

/** Entry (a): the real REST sessions router on a real HTTP server, fake SessionManager deps. */
async function returnViaRest(fixture: Awaited<ReturnType<typeof harness>>, cwd: string): Promise<void> {
  const { default: express } = await import('express');
  const { createSessionsRouter } = await import('../../src/web/routes/sessions');
  const deps = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tryGetSessionManager: async () => ({
      restoreSession: async () => ({ id: 'env-session', title: 'Environment fixture', workingDirectory: cwd, createdAt: 1, updatedAt: 1, messages: fixture.messages() }),
    }),
    getSupabaseForSession: async () => null,
  } as unknown as Parameters<typeof createSessionsRouter>[0];
  const app = express();
  app.use('/api', createSessionsRouter(deps));
  const server = await new Promise<http.Server>((resolve) => { const next = app.listen(0, '127.0.0.1', () => resolve(next)); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP test server address');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/env-session`);
    const body = await response.json() as { success: boolean; data?: { id?: string; activeRun?: boolean } };
    console.log('ENTRY_REST', JSON.stringify({ status: response.status, success: body.success, id: body.data?.id, activeRun: body.data?.activeRun }));
  } finally {
    server.close();
  }
}

/** Entry (b): the shared domain session-load handler with the production desktop context factory. */
async function returnViaDomain(cwd: string): Promise<void> {
  const { createDesktopSessionContext, sessionRoutes } = await import('../../src/host/ipc/domainRoutes/sessionRoutes');
  const session = { id: 'env-session', title: 'Environment fixture', workingDirectory: cwd, createdAt: 1, updatedAt: 1, messages: [] };
  const getAppService = ((): unknown => ({ loadSession: async () => session })) as Parameters<typeof createDesktopSessionContext>[0];
  const ctx = createDesktopSessionContext(getAppService);
  const loaded = await sessionRoutes.actions.load(ctx, { sessionId: 'env-session' });
  console.log('ENTRY_DOMAIN', JSON.stringify({ id: (loaded as { id?: string } | null)?.id ?? null }));
}

if (mode.startsWith('park')) {
  const fixture = await harness(workspace, file, sideEffect);
  await fixture.park();
  process.stdout.write(`READY ${process.pid}\n`);
  setInterval(() => {}, 1_000);
} else {
  if (mode === 'recover-timeout') warpLongTimeouts();
  const fixture = await harness(workspace, file, sideEffect);
  let probeCalls = 0;
  let probeState: 'red' | 'green' = mode === 'recover-noentry' ? 'green' : 'red';
  // Continuer keeps the fixture's proven registration shape (continueParkedDurableRun with
  // the harness recovery ports); registerAgentContinueRoute's own registration is exercised
  // in-process by envResumePark.test.ts and sessionDomainHandler.envResume.test.ts. The
  // production session-return ENTRY below is what this child is under test for.
  registerEnvResumeContinuer(async () => fixture.continueRun(), () => () => { probeCalls++; return Promise.resolve(probeState); });
  const plans = await fixture.registry.recoverDurable(Date.now() + 120_001);
  const dispatcher = new DurableRecoveryDispatcher();
  let recoveredAutomatically = 0;
  dispatcher.registerEngineHandler({ name: 'env-startup-observer', engineKind: 'native', recover: async () => { recoveredAutomatically++; return { status: 'recovered', reason: 'unexpected startup recovery' }; } });
  console.log('STARTUP_DISPATCH', JSON.stringify(await dispatcher.dispatch(plans, Date.now() + 120_001)));
  await sleep(1_100);
  console.log('STARTUP_PARK', JSON.stringify(await fixture.repository.get('env-run')));
  console.log('STARTUP_AUTO_CONTINUES', fixture.counts().resumes, 'RECOVERY_HANDLER_CALLS', recoveredAutomatically);
  if (fixture.counts().resumes || recoveredAutomatically || plans.length !== 1 || !plans[0].resumeBlocked) throw new Error('startup automatically continued');
  const userMessageCount = () => fixture.messages().filter((message) => message.role === 'user').length;

  if (mode === 'recover-noentry') {
    await sleep(2_600); // > 2x ENV_RESUME_POLL_INTERVAL_MS with a green probe registered
    console.log('AFTER_NOENTRY', JSON.stringify(await fixture.repository.get('env-run')));
    if (probeCalls !== 0 || fixture.counts().resumes !== 0) throw new Error('noentry case polled or continued');
    if ((await fixture.repository.get('env-run'))?.status !== 'waiting') throw new Error('noentry case left waiting');
  } else {
    if (mode === 'recover-domain') await returnViaDomain(workspace);
    else await returnViaRest(fixture, workspace);
    if (mode === 'recover-repeat') { await returnViaRest(fixture, workspace); await returnViaRest(fixture, workspace); }

    if (mode === 'recover-timeout') {
      const warnLine = await waitFor(() => waiterLines.find((line) => line.includes('WARN') && line.includes('timeout')), 8_000);
      console.log('TIMEOUT_WAITER_LOG', warnLine ?? 'MISSING');
      if (!warnLine || !warnLine.includes('env-run') || !warnLine.includes('env-session')) throw new Error('timeout warn line missing run/session');
      console.log('AFTER_TIMEOUT', JSON.stringify(await fixture.repository.get('env-run')));
      if (fixture.counts().resumes !== 0 || (await fixture.repository.get('env-run'))?.status !== 'waiting') throw new Error('timeout case continued or left waiting');
      fixture.green(); probeState = 'green';
      await fixture.continueRun(); // manual Continue must still work
      await waitFor(async () => ((await fixture.repository.get('env-run'))?.status === 'completed' ? true : undefined), 10_000);
      console.log('AFTER_MANUAL', JSON.stringify(await fixture.repository.get('env-run')));
      if ((await fixture.repository.get('env-run'))?.status !== 'completed') throw new Error('manual continue after timeout failed');
    } else {
      await sleep(mode === 'recover-repeat' ? 2_300 : 1_300); // red poll ticks before the environment is fixed
      if (probeCalls < 1) throw new Error('probe never polled while red');
      if ((await fixture.repository.get('env-run'))?.status !== 'waiting') throw new Error('run continued before green');
      if (mode === 'recover-repeat') {
        if (probeCalls < 2 || probeCalls > 3) throw new Error(`repeat case poll count ${probeCalls} is not single-loop ticks`);
        if (waiterLines.filter((line) => line.includes('armed on session return')).length !== 1) throw new Error('repeat case armed more than one loop');
      }
      fixture.green(); probeState = 'green';
      await waitFor(async () => ((await fixture.repository.get('env-run'))?.status === 'completed' ? true : undefined), 15_000);
      const envelope = await fixture.repository.get('env-run');
      console.log('AFTER_GREEN', JSON.stringify(envelope));
      if (envelope?.status !== 'completed' || fixture.counts().resumes !== 1) throw new Error('green did not continue same run exactly once');
      if (userMessageCount() !== 1) throw new Error(`expected exactly one user message, saw ${userMessageCount()}`);
      if (mode === 'recover-write') {
        // Restart semantics: this process only sees the continue side, so the write tool
        // not re-executing means zero executions here and exactly one begin row in SQLite.
        const begins = (fixture.db.prepare("SELECT COUNT(*) AS c FROM tool_execution_events WHERE phase='begin'").get() as { c: number }).c;
        console.log('TOOL_BEGINS', begins);
        if (fixture.counts().executions !== 0 || begins !== 1) throw new Error('sideEffect tool re-executed');
        const tool = fixture.messages().find((message) => message.role === 'tool');
        if (tool?.toolResults?.[0]?.toolCallId !== 'env-call' || !tool.toolResults?.[0]?.error?.includes('interrupted:')) throw new Error('model did not receive an interrupted result for the same call');
      }
    }
  }

  console.log('PROBE_CALLS', probeCalls);
  for (const line of waiterLines) console.log('WAITER_LOG', line);
  fixture.dump();
  await dispatcher.shutdown(); fixture.close();
  // Some imported application services own lazy timers; this fixture owns the process.
  process.exit(0);
}
