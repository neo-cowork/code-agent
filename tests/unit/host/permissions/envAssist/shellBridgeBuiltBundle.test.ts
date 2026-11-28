// Runs the BUILT desktop entry (dist/web/webServer.cjs -> webServer.bundle.cjs), not the TypeScript source:
// the shell hands the loopback bridge credentials over on stdin and the host log must show whether they arrived.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const ENTRY = 'dist/web/webServer.cjs';
const BUNDLE = 'dist/web/webServer.bundle.cjs';
const BUILD_DEADLINE_MS = 180_000;
const BOOT_DEADLINE_MS = 90_000;
const POLL_INTERVAL_MS = 250;
const VITEST_MARGIN_MS = 15_000;
const LOG_TAIL_CHARS = 2_000;
const TEST_TIMEOUT_MS = BOOT_DEADLINE_MS + VITEST_MARGIN_MS;

type Variant = 'handshake' | 'no_flag' | 'stdin_eof' | 'bad_line';

function elapsedSeconds(started: number): string {
  return ((performance.now() - started) / 1000).toFixed(2);
}

describe.skipIf(process.platform !== 'darwin')('built webServer bundle: shell bridge handshake', () => {
  let buildRoot: string | undefined;

  beforeAll(() => {
    const started = performance.now();
    try {
      buildRoot = mkdtempSync(path.join(tmpdir(), 'env-assist-build-'));
      // The normal web target writes fixed dist paths. Build in a private root so
      // esbuildExecutableArtifacts.test.ts can remove and rebuild its own output.
      // Keep the real source paths for esbuild's module resolution. The release
      // check script needs a real file for its import.meta.url entry point check.
      cpSync(path.join(REPO_ROOT, 'scripts'), path.join(buildRoot, 'scripts'), { recursive: true, verbatimSymlinks: true });
      for (const input of ['src', 'artifact-knowledge', 'config', 'node_modules', 'packages', 'src-tauri', 'tsconfig.json', 'package.json']) {
        symlinkSync(path.join(REPO_ROOT, input), path.join(buildRoot, input));
      }
      const built = spawnSync(process.execPath, [
        path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
        path.join(REPO_ROOT, 'esbuild.config.ts'),
        'web',
      ], {
        cwd: buildRoot,
        env: { ...process.env, HOME: buildRoot, USERPROFILE: buildRoot },
        encoding: 'utf8',
        timeout: Math.max(1, Math.ceil(BUILD_DEADLINE_MS - (performance.now() - started))),
        killSignal: 'SIGKILL',
      });
      if (built.error || built.status !== 0) {
        throw new Error(`${built.error?.message ?? `code=${built.status} signal=${built.signal}`}\n${built.stdout}\n${built.stderr}`);
      }
      if (!existsSync(path.join(buildRoot, ENTRY)) || !existsSync(path.join(buildRoot, BUNDLE))) {
        throw new Error('webServer entry or bundle missing after a successful build');
      }
    } catch (error) {
      throw new Error(`beforeAll web build failed (elapsed ${elapsedSeconds(started)} s): ${error}`, { cause: error });
    }
  }, BUILD_DEADLINE_MS + VITEST_MARGIN_MS);

  afterAll(async () => {
    if (buildRoot) await rm(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo;
        server.close((error) => { if (error) reject(error); else resolve(port); });
      });
    });
  }

  async function bootAndReadLog(variant: Variant): Promise<string> {
    if (!buildRoot) throw new Error('beforeAll web build did not create a build root');
    const port = await freePort();
    const home = mkdtempSync('/tmp/env-assist-built-');
    const dataDir = path.join(home, 'data');
    const started = performance.now();
    const deadline = started + BOOT_DEADLINE_MS;
    const child = spawn(process.execPath, [path.join(buildRoot, ENTRY)], {
      cwd: home,
      env: {
        PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(process.execPath)}`, HOME: home, TMPDIR: '/tmp',
        CODE_AGENT_DATA_DIR: dataDir, WEB_PORT: String(port),
        CODE_AGENT_TAURI_BOOT_TOKEN: 'built-bundle-test',
        ...(variant === 'no_flag' ? {} : { CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE: '1' }),
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const closed = new Promise<void>((resolve) => { child.once('close', resolve); });
    let spawnError: Error | undefined;
    let stderr = '';
    child.once('error', (error) => { spawnError = error; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-LOG_TAIL_CHARS); });
    // On early exit stdin can emit EPIPE before Node reports the child's exit code.
    child.stdin.on('error', () => {});

    const readLogs = (): string => {
      try {
        const dir = path.join(dataDir, 'logs');
        return readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('');
      } catch { return ''; }
    };

    try {
      if (variant === 'stdin_eof') child.stdin.end();
      else if (variant === 'bad_line') child.stdin.write('garbage line\n');
      else child.stdin.write('CODE_AGENT_ENV_ASSIST_BRIDGE http://127.0.0.1:9 built-bundle-token\n'); // pipe stays open, like the shell

      // boot-timing follows registerHandlers, which emits the bridge diagnostics.
      while (true) {
        const log = readLogs();
        if (log.includes('[boot-timing] webServer startup segments')) return log;
        if (spawnError) throw new Error(`${variant}: child spawn failed (after ${elapsedSeconds(started)} s): ${spawnError.message}`);
        if (child.exitCode !== null || child.signalCode !== null) {
          await closed;
          throw new Error(`${variant}: child exited early (code=${child.exitCode}, signal=${child.signalCode}, after ${elapsedSeconds(started)} s); stderr tail:\n${stderr}\nlog tail:\n${log.slice(-LOG_TAIL_CHARS)}`);
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new Error(`${variant}: never reached boot-timing within ${BOOT_DEADLINE_MS / 1000} s (log polling; log tail:\n${log.slice(-LOG_TAIL_CHARS)}\nstderr tail:\n${stderr})`);
        }
        await delay(Math.min(POLL_INTERVAL_MS, remaining));
      }
    } finally {
      // The child can still be writing logs until it stops.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  it('stdin handshake reaches the bundled host: no no_shell line', async () => {
    const log = await bootAndReadLog('handshake');
    expect(log).not.toContain('env_assist_bridge:no_shell');
    expect(log).not.toContain('env_assist_bridge:handshake_invalid');
  }, TEST_TIMEOUT_MS);

  it('missing handshake flag leaves a no_shell trace in the host log', async () => {
    const noFlag = await bootAndReadLog('no_flag');
    expect(noFlag).toContain('env_assist_bridge:no_shell');
    expect(noFlag).toContain('"reason":"handshake_flag_missing"');
  }, TEST_TIMEOUT_MS);

  it('stdin EOF leaves a handshake_invalid trace in the host log', async () => {
    const eof = await bootAndReadLog('stdin_eof');
    expect(eof).toContain('env_assist_bridge:handshake_invalid');
    expect(eof).toContain('"reason":"stdin_eof"');
  }, TEST_TIMEOUT_MS);

  it('a bad handshake prefix leaves a bad_prefix trace in the host log', async () => {
    const bad = await bootAndReadLog('bad_line');
    expect(bad).toContain('"reason":"bad_prefix"');
  }, TEST_TIMEOUT_MS);
});
