// Runs the BUILT desktop entry (dist/web/webServer.cjs -> webServer.bundle.cjs), not the TypeScript source:
// the shell hands the loopback bridge credentials over on stdin and the host log must show whether they arrived.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const ENTRY = path.resolve(__dirname, '../../../../../dist/web/webServer.cjs');
const BUNDLE = path.resolve(path.dirname(ENTRY), 'webServer.bundle.cjs');

type Variant = 'handshake' | 'no_flag' | 'stdin_eof' | 'bad_line';

describe.skipIf(process.platform !== 'darwin')('built webServer bundle: shell bridge handshake', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

  // A fresh checkout has no dist/: build the real bundle instead of skipping (fast gates forbid skipped tests).
  beforeAll(() => {
    if (existsSync(ENTRY) && existsSync(BUNDLE)) return;
    console.warn(`[shellBridgeBuiltBundle] ${BUNDLE} is absent — building it with the web target`);
    const built = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'esbuild.config.ts', 'web'], {
      cwd: path.resolve(__dirname, '../../../../..'), encoding: 'utf8',
    });
    if (built.status !== 0 || !existsSync(BUNDLE)) throw new Error(`web bundle build failed:\n${built.stdout}\n${built.stderr}`);
  }, 180000);

  async function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });
  }

  async function bootAndReadLog(variant: Variant): Promise<string> {
    const home = mkdtempSync('/tmp/env-assist-built-');
    const dataDir = path.join(home, 'data');
    const child = spawn(process.execPath, [ENTRY], {
      cwd: home,
      env: {
        PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(process.execPath)}`, HOME: home, TMPDIR: '/tmp',
        CODE_AGENT_DATA_DIR: dataDir, WEB_PORT: String(await freePort()),
        CODE_AGENT_TAURI_BOOT_TOKEN: 'built-bundle-test',
        ...(variant === 'no_flag' ? {} : { CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE: '1' }),
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    cleanup.push(async () => {
      // Wait for the host to be really gone, or it keeps writing logs while the directory is removed (ENOTEMPTY).
      const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    if (variant === 'stdin_eof') child.stdin.end();
    else if (variant === 'bad_line') child.stdin.write('garbage line\n');
    else child.stdin.write('CODE_AGENT_ENV_ASSIST_BRIDGE http://127.0.0.1:9 built-bundle-token\n'); // pipe stays open, like the shell

    const readLogs = (): string => {
      try {
        const dir = path.join(dataDir, 'logs');
        return readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('');
      } catch { return ''; }
    };
    // `boot-timing` is logged after registerHandlers (where the first no_shell is emitted), so absence is meaningful.
    for (let i = 0; i < 240; i += 1) {
      if (readLogs().includes('[boot-timing] webServer startup segments')) return readLogs();
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`built webServer never reached boot-timing; log:\n${readLogs().slice(-2000)}`);
  }

  it('stdin handshake reaches the bundled host: no no_shell line', async () => {
    const log = await bootAndReadLog('handshake');
    expect(log).not.toContain('env_assist_bridge:no_shell');
    expect(log).not.toContain('env_assist_bridge:handshake_invalid');
  }, 90000);

  it('degrade paths leave distinguishable traces in the host log file', async () => {
    const noFlag = await bootAndReadLog('no_flag');
    expect(noFlag).toContain('env_assist_bridge:no_shell');
    expect(noFlag).toContain('"reason":"handshake_flag_missing"');

    const eof = await bootAndReadLog('stdin_eof');
    expect(eof).toContain('env_assist_bridge:handshake_invalid');
    expect(eof).toContain('"reason":"stdin_eof"');

    const bad = await bootAndReadLog('bad_line');
    expect(bad).toContain('"reason":"bad_prefix"');
  }, 120000);
});
