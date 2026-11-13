import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');

/** Park a child holding an env_blocked run, SIGKILL it, then run the recover-mode child. */
async function killThenRecover(parkMode: string, recoverMode: string): Promise<{ first: string; second: string }> {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'env-kill-')));
  const file = path.join(directory, 'run.db');
  const script = path.join(process.cwd(), 'tests/fixtures/envResumeKillChild.ts');
  const children: ReturnType<typeof spawn>[] = [];
  const start = (mode: string) => {
    // Recover children need DEBUG=true: CLI mode gates info/warn at the logger instance
    // level, and the EnvResumeWaiter arm/stop lines are the evidence under test.
    const child = spawn(process.execPath, ['--import', 'tsx', script, mode, directory, file], {
      env: { ...process.env, CODE_AGENT_CLI_MODE: 'true', CODE_AGENT_WEB_MODE: 'false', DEBUG: mode.startsWith('park') ? 'false' : 'true', CODE_AGENT_NO_RUNTIME_AUTOINSTALL: '1', CODE_AGENT_DATA_DIR: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child); return child;
  };
  let first = '', second = '';
  try {
    const child = start(parkMode);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (chunk) => { first += String(chunk); if (/READY \d+/.test(first)) resolve(); });
      child.stderr!.on('data', (chunk) => { first += String(chunk); });
      child.once('error', reject); child.once('exit', (code) => reject(new Error(`park process exited ${code}: ${first}`)));
    });
    expect(first).toContain('env_blocked');
    process.stdout.write(`KILL -9 ${child.pid}\n`);
    child.kill('SIGKILL'); await exited;
    expect(child.signalCode).toBe('SIGKILL');
    const next = start(recoverMode);
    const code = await new Promise<number | null>((resolve, reject) => {
      next.stdout!.on('data', (chunk) => { second += String(chunk); });
      next.stderr!.on('data', (chunk) => { second += String(chunk); });
      next.once('error', reject); next.once('exit', resolve);
    });
    console.log(`PROCESS_ONE_RAW (${parkMode})\n` + first); console.log(`PROCESS_TWO_RAW (${recoverMode})\n` + second);
    if (process.env.ENV_RESUME_EVIDENCE_DIR) {
      writeFileSync(path.join(process.env.ENV_RESUME_EVIDENCE_DIR, `kill-${recoverMode}.log`), `${first}\n=== recover ===\n${second}`);
    }
    expect(code, second).toBe(0);
    for (const owned of children) expect(() => process.kill(owned.pid!, 0)).toThrow();
    process.stdout.write(`OWNED_PROCESSES_EXITED ${children.map((owned) => owned.pid).join(' ')}\n`);
    return { first, second };
  } finally {
    for (const owned of children) if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
}

const labeledLine = (raw: string, label: string): string | undefined =>
  raw.split('\n').find((line) => line.startsWith(`${label} `));
const countUserMessages = (raw: string): number =>
  (labeledLine(raw, 'MESSAGES')?.match(/"role":"user"/g) ?? []).length;
const countsLine = (raw: string): Record<string, unknown> | undefined => {
  const match = raw.match(/^COUNTS (\{.*\})$/m);
  return match ? JSON.parse(match[1]) as Record<string, unknown> : undefined;
};

describe('environment park survives process kill', () => {
  it('startup observes only; REST session return arms the waiter and auto-continues the same run', async () => {
    const { second } = await killThenRecover('park', 'recover');
    expect(second).toContain('STARTUP_AUTO_CONTINUES 0 RECOVERY_HANDLER_CALLS 0');
    expect(second).toContain('ENTRY_REST {"status":200,"success":true,"id":"env-session"');
    expect(second).toContain('Environment auto-continue armed on session return');
    expect(second).toContain('GET /sessions/:id');
    expect(second).toContain('AFTER_GREEN');
    expect(second).toContain('"status":"completed"');
    expect(second).toContain('"seenCalls":["env-call"]');
    expect(second).toContain('"seenRuns":["env-run"]');
    expect(countUserMessages(second)).toBe(1);
  }, 60_000);

  it('startup observes only; domain session load return arms the waiter and auto-continues the same run', async () => {
    const { second } = await killThenRecover('park', 'recover-domain');
    expect(second).toContain('STARTUP_AUTO_CONTINUES 0 RECOVERY_HANDLER_CALLS 0');
    expect(second).toContain('ENTRY_DOMAIN {"id":"env-session"}');
    expect(second).toContain('Environment auto-continue armed on session return');
    expect(second).toContain('domain:session:load');
    expect(second).toContain('AFTER_GREEN');
    expect(second).toContain('"status":"completed"');
    expect(second).toContain('"seenCalls":["env-call"]');
    expect(second).toContain('"seenRuns":["env-run"]');
    expect(countUserMessages(second)).toBe(1);
  }, 60_000);

  it('three returns inside one poll interval arm exactly one loop with single-loop probe ticks', async () => {
    const { second } = await killThenRecover('park', 'recover-repeat');
    expect(second).toContain('STARTUP_AUTO_CONTINUES 0 RECOVERY_HANDLER_CALLS 0');
    expect((second.match(/^WAITER_LOG .*armed on session return/gm) ?? []).length).toBe(1);
    expect(second).toContain('AFTER_GREEN');
    expect(second).toContain('"status":"completed"');
    expect(countsLine(second)).toMatchObject({ executions: 1, resumes: 1 });
    const probeCalls = Number(second.match(/^PROBE_CALLS (\d+)$/m)?.[1]);
    expect(probeCalls).toBeGreaterThanOrEqual(2);
    expect(probeCalls).toBeLessThanOrEqual(3);
  }, 60_000);

  it('without a session return nothing polls or continues even with a green probe registered', async () => {
    const { second } = await killThenRecover('park', 'recover-noentry');
    expect(second).toContain('STARTUP_AUTO_CONTINUES 0 RECOVERY_HANDLER_CALLS 0');
    expect(second).toContain('AFTER_NOENTRY');
    expect(second).toContain('"status":"waiting"');
    expect(second).toContain('PROBE_CALLS 0');
    expect(countsLine(second)).toMatchObject({ resumes: 0 });
    expect(second).not.toContain('Environment auto-continue armed on session return');
  }, 60_000);

  it('a red environment times the armed loop out after return and stays manually continuable', async () => {
    const { second } = await killThenRecover('park', 'recover-timeout');
    expect(second).toContain('STARTUP_AUTO_CONTINUES 0 RECOVERY_HANDLER_CALLS 0');
    expect(second).toContain('Environment auto-continue armed on session return');
    expect(second).toContain('WARN [EnvResumeWaiter] Environment auto-continue stopped');
    expect(second).toContain("reason: 'timeout'");
    expect(second).toContain("runId: 'env-run'");
    expect(second).toContain("sessionId: 'env-session'");
    expect(second).toContain('TIMEOUT_WAITER_LOG');
    expect(second).toContain('AFTER_TIMEOUT');
    expect(labeledLine(second, 'AFTER_TIMEOUT')).toContain('"status":"waiting"');
    expect(second).toContain('AFTER_MANUAL');
    expect(labeledLine(second, 'AFTER_MANUAL')).toContain('"status":"completed"');
    // The manual continue after the timeout completes the run exactly once (the child
    // asserts the auto-continuer count was 0 at AFTER_TIMEOUT before going manual).
    expect(countsLine(second)).toMatchObject({ executions: 1, resumes: 1 });
  }, 60_000);

  it('a sideEffect tool is never re-executed through the session-return auto-continue', async () => {
    const { second } = await killThenRecover('park-write', 'recover-write');
    expect(second).toContain('STARTUP_AUTO_CONTINUES 0 RECOVERY_HANDLER_CALLS 0');
    expect(second).toContain('Environment auto-continue armed on session return');
    expect(second).toContain('AFTER_GREEN');
    expect(second).toContain('"status":"completed"');
    expect(second).toContain('TOOL_BEGINS 1');
    expect(second).toContain('interrupted:');
    expect(second).toContain('"toolCallId":"env-call"');
    expect(countUserMessages(second)).toBe(1);
    expect(countsLine(second)).toMatchObject({ executions: 0, resumes: 1, seenCalls: [], seenRuns: [] });
  }, 60_000);
});
