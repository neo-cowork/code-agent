import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const guardLibrary = join(repoRoot, 'scripts', 'lib', 'tauri-slot-process-guard.sh');

type Slot = {
  name: string;
  appPath: string;
  executable: string;
  port: number;
};

let scratch = '';
let slot1: Slot;
let slot2: Slot;
const children: ChildProcess[] = [];

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unused port unavailable');
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return address.port;
}

async function makeSlot(name: string): Promise<Slot> {
  const appPath = join(scratch, `${name}.app`);
  const executable = join(appPath, 'Contents', 'MacOS', 'code-agent-tauri');
  mkdirSync(join(executable, '..'), { recursive: true });
  copyFileSync('/bin/sleep', executable);
  chmodSync(executable, 0o755);
  if (process.platform === 'darwin') {
    const signed = spawnSync('codesign', ['--force', '--sign', '-', executable], { encoding: 'utf8' });
    expect(signed.status, signed.stderr).toBe(0);
  }
  return { name, appPath, executable, port: await unusedPort() };
}

async function startSlot(slot: Slot): Promise<ChildProcess> {
  const child = spawn(slot.executable, ['60'], { stdio: 'ignore' });
  children.push(child);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = spawnSync('bash', [
      '-c',
      'source "$1"; find_tauri_slot_instances "$2" "$3"',
      'real-guard-ready',
      guardLibrary,
      slot.appPath,
      String(slot.port),
    ], { encoding: 'utf8' });
    if (found.stdout.includes(`pid=${child.pid} `)) return child;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`real slot process was not discoverable: ${slot.executable}`);
}

function runGuard(slot: Slot, force: boolean, terminate: boolean) {
  const terminateCommand = terminate ? '; terminate_confirmed_tauri_slot_instances' : '';
  return spawnSync('bash', [
    '-c',
    `set -e; source "$1"; refuse_if_tauri_slot_in_use "$2" "$3" "$4"${terminateCommand}`,
    'real-guard-test',
    guardLibrary,
    slot.name,
    slot.appPath,
    String(slot.port),
  ], {
    encoding: 'utf8',
    env: { ...process.env, NEO_INSTALL_FORCE: force ? '1' : '0' },
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isAlive(child: ChildProcess): boolean {
  if (child.pid === undefined || hasExited(child)) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return;
  await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'tauri-slot-real-processes-'));
  slot1 = await makeSlot('Agent Neo Dev');
  slot2 = await makeSlot('Agent Neo Dev 2');
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!hasExited(child)) child.kill('SIGKILL');
    await waitForExit(child);
  }
  const remaining = spawnSync('pgrep', ['-fl', 'code-agent-tauri'], { encoding: 'utf8' });
  expect(remaining.status, remaining.stderr).not.toBeGreaterThan(1);
  expect(remaining.stdout).not.toContain(scratch);
  rmSync(scratch, { recursive: true, force: true });
});

describe('tauri slot guard with real processes', () => {
  it('refuses an occupied slot 1 without signalling either real app process', async () => {
    const first = await startSlot(slot1);
    const second = await startSlot(slot2);

    const result = runGuard(slot1, false, false);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`pid=${first.pid}`);
    expect(isAlive(first)).toBe(true);
    expect(isAlive(second)).toBe(true);
  });

  it('force-terminates only the confirmed slot 1 pid and preserves slot 2', async () => {
    const first = await startSlot(slot1);
    const second = await startSlot(slot2);

    const result = runGuard(slot1, true, true);
    await waitForExit(first);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`pid=${first.pid}`);
    expect(first.signalCode).toBe('SIGTERM');
    expect(isAlive(second)).toBe(true);
  });

  it('passes slot 1 when only slot 2 is occupied and terminates nothing', async () => {
    const second = await startSlot(slot2);

    const result = runGuard(slot1, true, true);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(isAlive(second)).toBe(true);
  });
});
