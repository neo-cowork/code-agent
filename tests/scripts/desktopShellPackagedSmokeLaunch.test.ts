import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SMOKE_SCRIPT = path.resolve('scripts/desktop-shell-packaged-smoke.mjs');
const isDarwin = process.platform === 'darwin';

function write(file: string, content: string, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-launch-test-'));
  const app = path.join(root, 'Fake Neo.app');
  const marker = path.join(root, 'EXECUTED');
  write(path.join(app, 'Contents/MacOS/code-agent-tauri'), `#!/bin/sh\ntouch "${marker}"\n`);
  write(path.join(app, 'Contents/Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>test.fake.neo</string></dict></plist>', 0o644);
  const bin = path.join(root, 'bin');
  const openLog = path.join(root, 'open-argv.txt');
  const openFlag = path.join(root, 'open-called');
  write(path.join(bin, 'open'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${openLog}"\ntouch "${openFlag}"\nexit 0\n`);
  write(path.join(bin, 'lsof'), '#!/bin/sh\nexit 1\n');
  return { root, app, marker, bin, openLog, openFlag };
}

function runSmoke(env: ReturnType<typeof setup>, extra: string[], pathEnv?: string) {
  return spawnSync(process.execPath, [
    SMOKE_SCRIPT, '--app', env.app, '--data-dir', path.join(env.root, 'data'),
    '--tauri-data-dir', path.join(env.root, 'tauri'), '--port', '58123', '--timeout-ms', '1500', '--json', ...extra,
  ], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: pathEnv ?? `${env.bin}:${process.env.PATH}` } });
}

describe.skipIf(!isDarwin)('desktop-shell-packaged-smoke launches via LaunchServices', () => {
  it('(a) calls open -n with the env pairs and the .app path, and never execs Contents/MacOS', () => {
    const env = setup();
    try {
      const res = runSmoke(env, []);
      const argv = fs.readFileSync(env.openLog, 'utf8').trim().split('\n');
      expect(argv).toContain('-n');
      expect(argv).toContain(`CODE_AGENT_DATA_DIR=${path.join(env.root, 'data')}`);
      expect(argv).toContain('CODE_AGENT_WEB_PORT=58123');
      expect(argv).toContain('WEB_PORT=58123');
      expect(argv[argv.length - 1]).toBe(env.app);
      expect(fs.existsSync(env.marker)).toBe(false);
      const result = JSON.parse(res.stdout);
      expect(result.launch.openExitCode).toBe(0);
      expect(result.launch.openArgv[0]).toBe('open');
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  it('(b) teardown kills only pids new since launch and leaves a pre-existing same-bundle pid alone', async () => {
    const env = setup();
    const old = spawn('sleep', ['60'], { stdio: 'ignore' });
    const fresh = spawn('sleep', ['60'], { stdio: 'ignore' });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      const cmd = (pid: number) => `${pid} ${env.app}/Contents/MacOS/code-agent-tauri`;
      write(path.join(env.bin, 'ps'), `#!/bin/sh\necho "${cmd(old.pid!)}"\n[ -f "${env.openFlag}" ] && echo "${cmd(fresh.pid!)}"\nexit 0\n`);
      runSmoke(env, []);
      await new Promise((r) => setTimeout(r, 300));
      expect(alive(old.pid!)).toBe(true);
      expect(alive(fresh.pid!)).toBe(false);
    } finally {
      old.kill('SIGKILL'); fresh.kill('SIGKILL');
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  it('(c) --keep-running reclaims nothing', async () => {
    const env = setup();
    const fresh = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      write(path.join(env.bin, 'ps'), `#!/bin/sh\n[ -f "${env.openFlag}" ] && echo "${fresh.pid} ${env.app}/Contents/MacOS/code-agent-tauri"\nexit 0\n`);
      runSmoke(env, ['--keep-running']);
      await new Promise((r) => setTimeout(r, 300));
      expect(() => process.kill(fresh.pid!, 0)).not.toThrow();
    } finally {
      fresh.kill('SIGKILL');
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });
});
