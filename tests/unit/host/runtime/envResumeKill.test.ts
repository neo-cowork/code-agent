import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');

describe('environment park survives process kill', () => {
  it('keeps the SQLite park, observes startup, then resumes after explicit waiter arming', async () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'env-kill-')));
    const file = path.join(directory, 'run.db');
    const script = path.join(process.cwd(), 'tests/fixtures/envResumeKillChild.ts');
    const children: ReturnType<typeof spawn>[] = [];
    const start = (mode: string) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script, mode, directory, file], {
        env: { ...process.env, CODE_AGENT_CLI_MODE: 'true', CODE_AGENT_WEB_MODE: 'false', DEBUG: 'false', CODE_AGENT_NO_RUNTIME_AUTOINSTALL: '1', CODE_AGENT_DATA_DIR: directory },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child); return child;
    };
    let first = '', second = '';
    try {
      const child = start('park');
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
      const next = start('recover');
      const code = await new Promise<number | null>((resolve, reject) => {
        next.stdout!.on('data', (chunk) => { second += String(chunk); });
        next.stderr!.on('data', (chunk) => { second += String(chunk); });
        next.once('error', reject); next.once('exit', resolve);
      });
      console.log('PROCESS_ONE_RAW\n' + first); console.log('PROCESS_TWO_RAW\n' + second);
      if (process.env.ENV_RESUME_EVIDENCE_DIR) {
        writeFileSync(path.join(process.env.ENV_RESUME_EVIDENCE_DIR, 'kill-park.log'), first);
        writeFileSync(path.join(process.env.ENV_RESUME_EVIDENCE_DIR, 'kill-recover.log'), second);
      }
      expect(code, second).toBe(0);
      expect(second).toContain('STARTUP_AUTO_CONTINUES 0 RECOVERY_HANDLER_CALLS 0');
      expect(second).toContain('AFTER_GREEN');
      expect(second).toContain('"seenCalls":["env-call"]');
      expect(second).toContain('"seenRuns":["env-run"]');
      for (const owned of children) expect(() => process.kill(owned.pid!, 0)).toThrow();
      process.stdout.write(`OWNED_PROCESSES_EXITED ${children.map((owned) => owned.pid).join(' ')}\n`);
    } finally {
      for (const owned of children) if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL');
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
