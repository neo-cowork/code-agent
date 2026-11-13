import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/run-dev-slot.sh');

function runDryRun(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', [SCRIPT, ...args, '--dry-run'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NEO_SLOT_BACKGROUND: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

describe('run-dev-slot.sh --dry-run', () => {
  it('prints the foreground command for an open-only slot', () => {
    const output = runDryRun(['3', '--open-only'], { NEO_SLOT_BACKGROUND: '0' });

    expect(output.trim()).toBe('[run-dev-slot] would run: open "/Applications/Agent Neo Dev 3.app"');
  });

  it('prints the background command for the flag and environment forms', () => {
    const expected = '[run-dev-slot] would run: open --env NEO_VERIFY_NO_FOREGROUND=1 -g -j "/Applications/Agent Neo Dev 3.app"';

    expect(runDryRun(['3', '--open-only', '--background'], { NEO_SLOT_BACKGROUND: '0' }).trim()).toBe(expected);
    expect(runDryRun(['3', '--open-only'], { NEO_SLOT_BACKGROUND: '1' }).trim()).toBe(expected);
    expect(runDryRun(['1', '--open-only', '--background'], { NEO_SLOT_BACKGROUND: '0' }).trim()).toBe(
      '[run-dev-slot] would run: open --env NEO_VERIFY_NO_FOREGROUND=1 -g -j "/Applications/Agent Neo Dev.app"',
    );
  });

  it('keeps foreground launch as the default', () => {
    const output = runDryRun(['2', '--open-only'], { NEO_SLOT_BACKGROUND: '0' });

    expect(output).toContain('open "/Applications/Agent Neo Dev 2.app"');
    expect(output).not.toContain('-g');
    expect(output).not.toContain('-j');
    expect(output).not.toContain('--env NEO_VERIFY_NO_FOREGROUND=1');
  });

  it('documents known focus-stealing actions in the usage header', () => {
    const usage = readFileSync(SCRIPT, 'utf8');

    expect(usage).toContain('# Known focus-stealing actions under --background (expected, not measured):');
    expect(usage).toContain('#   - renderer-side external links (Tauri opener)');
    expect(usage).toContain('#   - the update-URL command');
    expect(usage).toContain('#   - system permission prompts');
    expect(usage).toContain('#   - OAuth browser windows started from the renderer');
  });

  it('reports both new flags in the usage line for invalid arguments', () => {
    let error: unknown;
    try {
      runDryRun(['--unknown']);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect((error as { status?: number }).status).toBe(1);
    expect(outputText((error as { stderr?: unknown }).stderr)).toMatch(
      /Usage: .*--background.*--dry-run/,
    );
  });

  it('does not invoke npm, node, or open during a dry run', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'run-dev-slot-'));
    const bin = path.join(root, 'bin');
    const marker = path.join(root, 'invoked');
    mkdirSync(bin);

    try {
      for (const command of ['npm', 'node', 'open']) {
        const stub = path.join(bin, command);
        writeFileSync(stub, '#!/bin/bash\nprintf \'%s\\n\' "$0" >> "$RUN_DEV_SLOT_MARKER"\n');
        chmodSync(stub, 0o755);
      }

      const output = runDryRun(['3'], {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RUN_DEV_SLOT_MARKER: marker,
      });

      expect(output.trim()).toBe('[run-dev-slot] would run: open "/Applications/Agent Neo Dev 3.app"');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('run-dev-slot.sh --fresh-user', () => {
  function withStub(callback: (env: NodeJS.ProcessEnv, root: string) => void): void {
    const root = mkdtempSync(path.join(os.tmpdir(), 'fresh-slot-'));
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const stub = path.join(bin, 'pgrep');
    writeFileSync(stub, '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$PGREP_ARGS"\nexit "${PGREP_STATUS:-1}"\n');
    chmodSync(stub, 0o755);
    try {
      callback({
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        PGREP_ARGS: path.join(root, 'pgrep-args'),
        NEO_FRESH_ROOT: path.join(root, 'fresh root'),
      }, root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it.each(['1', '2', '3', '4', '5', '6', '7', '8', '9'])('prints a fresh foreground command for slot %s without creating a directory', (slot) => {
    withStub((env) => {
      const output = runDryRun([slot, '--open-only', '--fresh-user'], env);
      const appName = slot === '1' ? 'Agent Neo Dev' : `Agent Neo Dev ${slot}`;
      const lines = output.trim().split('\n');
      expect(lines[0]).toMatch(new RegExp(
        `^\\[run-dev-slot\\] would run: open --env CODE_AGENT_DATA_DIR=".*neo-fresh-slot${slot}-\\d{8}-\\d{6}" --env CODE_AGENT_FRESH_USER=fresh-[a-f0-9]{24} "/Applications/${appName}\\.app"$`,
      ));
      const dir = lines[0].match(/CODE_AGENT_DATA_DIR="([^"]+)"/)?.[1];
      expect(dir).toBeDefined();
      expect(lines[1]).toBe(`[run-dev-slot] cleanup: rm -rf "${dir}"`);
      expect(output).not.toContain('.code-agent-dev');
      expect(output).not.toContain(path.join(os.homedir(), '.code-agent'));
      expect(existsSync(env.NEO_FRESH_ROOT!)).toBe(false);
      expect(readFileSync(env.PGREP_ARGS!, 'utf8')).toBe(
        `-f\n/Applications/${appName}.app/Contents/MacOS/\n`,
      );
    });
  });

  it.each(['1', '2', '3', '4', '5', '6', '7', '8', '9'])('preserves fresh background launch for slot %s in both forms', (slot) => {
    withStub((env) => {
      const appName = slot === '1' ? 'Agent Neo Dev' : `Agent Neo Dev ${slot}`;
      for (const form of ['flag', 'environment']) {
        const output = runDryRun([slot, '--fresh-user', ...(form === 'flag' ? ['--background'] : [])], {
          ...env, NEO_SLOT_BACKGROUND: form === 'environment' ? '1' : '0',
        });
        expect(output).toContain(`--env NEO_VERIFY_NO_FOREGROUND=1 -g -j "/Applications/${appName}.app"`);
        expect(output).toMatch(/--env CODE_AGENT_FRESH_USER=fresh-[a-f0-9]{24} --env NEO_VERIFY/);
      }
    });
  });

  it('generates a different fresh identity on consecutive runs', () => {
    withStub((env) => {
      const names = [0, 1].map(() => {
        const output = runDryRun(['2', '--open-only', '--fresh-user'], env);
        const name = output.match(/CODE_AGENT_FRESH_USER=(fresh-[a-f0-9]{24})/)?.[1];
        expect(name).toBeDefined();
        expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,30}$/);
        return name;
      });
      expect(names[0]).not.toBe(names[1]);
    });
  });

  it.each(['1', '2'])('refuses a running slot %s before the dry-run exit', (slot) => {
    withStub((env) => {
      const appName = slot === '1' ? 'Agent Neo Dev' : `Agent Neo Dev ${slot}`;
      let error: unknown;
      try {
        runDryRun([slot, '--open-only', '--fresh-user'], { ...env, PGREP_STATUS: '0' });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect((error as { status?: number }).status).toBe(1);
      expect(outputText((error as { stderr?: unknown }).stderr)).toBe(
        `Error: slot ${slot} (${appName}) already running; quit it first\n`,
      );
      expect(outputText((error as { stdout?: unknown }).stdout)).not.toContain('would run');
      const pattern = readFileSync(env.PGREP_ARGS!, 'utf8').trim().split('\n');
      expect(pattern).toEqual(['-f', `/Applications/${appName}.app/Contents/MacOS/`]);
      const otherName = slot === '1' ? 'Agent Neo Dev 2' : 'Agent Neo Dev';
      expect(new RegExp(pattern[1]).test(`/Applications/${otherName}.app/Contents/MacOS/code-agent-tauri`)).toBe(false);
      expect(existsSync(env.NEO_FRESH_ROOT!)).toBe(false);
    });
  });

  it.each(['.code-agent', '.code-agent/nested', '.code-agent-x', 'safe/../.code-agent-x'])('rejects a protected root %s', (suffix) => {
    withStub((env, root) => {
      expect(() => runDryRun(['--fresh-user'], {
        ...env, HOME: root, NEO_FRESH_ROOT: path.join(root, suffix),
      })).toThrow();
      expect(readdirSync(root).sort()).toEqual(['bin', 'pgrep-args']);
    });
  });

  it('rejects a symlink into protected user data', () => {
    withStub((env, root) => {
      const protectedRoot = path.join(root, '.code-agent');
      mkdirSync(protectedRoot);
      symlinkSync(protectedRoot, path.join(root, 'alias'));
      expect(() => runDryRun(['--fresh-user'], {
        ...env, HOME: root, NEO_FRESH_ROOT: path.join(root, 'alias', 'nested'),
      })).toThrow();
      expect(readdirSync(protectedRoot)).toEqual([]);
    });
  });

  it('creates fresh data only on launch and refuses same-second reuse', () => {
    withStub((env, root) => {
      const scripts = path.join(root, 'scripts');
      const bin = path.join(root, 'bin');
      mkdirSync(scripts);
      mkdirSync(path.join(root, 'src-tauri'));
      const script = path.join(scripts, 'run-dev-slot.sh');
      copyFileSync(SCRIPT, script);
      writeFileSync(path.join(root, 'src-tauri', '.dev-slot.json'), JSON.stringify({
        productName: 'Agent Neo Dev 9', webPort: 8189,
      }));
      for (const [name, body] of Object.entries({
        npm: 'exit 0',
        date: 'printf "20261109-120000"',
        open: 'printf "%s\\n" "$@" > "$OPEN_ARGS"\n[ -d "${2#CODE_AGENT_DATA_DIR=}" ]',
      })) {
        const stub = path.join(bin, name);
        writeFileSync(stub, `#!/bin/bash\n${body}\n`);
        chmodSync(stub, 0o755);
      }
      const launchEnv = { ...process.env, ...env, NEO_SLOT_BACKGROUND: '0', OPEN_ARGS: path.join(root, 'open-args') };
      const run = () => execFileSync('bash', [script, '9', '--fresh-user'], {
        cwd: root, encoding: 'utf8', env: launchEnv, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output = run();
      const freshDir = path.join(env.NEO_FRESH_ROOT!, 'neo-fresh-slot9-20261109-120000');
      expect(existsSync(freshDir)).toBe(true);
      expect(output).toContain(`cleanup: rm -rf "${freshDir}"`);
      const args = readFileSync(launchEnv.OPEN_ARGS, 'utf8').trim().split('\n');
      expect(args).toEqual([
        '--env', `CODE_AGENT_DATA_DIR=${freshDir}`,
        '--env', expect.stringMatching(/^CODE_AGENT_FRESH_USER=fresh-[a-f0-9]{24}$/),
        '/Applications/Agent Neo Dev 9.app',
      ]);
      rmSync(freshDir, { recursive: true });
      writeFileSync(path.join(bin, 'open'), '#!/bin/bash\nexit 1\n');
      let failure: unknown;
      try {
        run();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(outputText((failure as { stderr?: unknown }).stderr)).toMatch(
        /open --env CODE_AGENT_DATA_DIR="[^"]+" --env CODE_AGENT_FRESH_USER=fresh-[a-f0-9]{24} "/,
      );
      writeFileSync(path.join(freshDir, 'populated'), 'keep');
      expect(run).toThrow();
      expect(readFileSync(path.join(freshDir, 'populated'), 'utf8')).toBe('keep');
    });
  });

  it('never checks running apps without the fresh flag', () => {
    withStub((env) => {
      for (const slot of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
        for (const background of [[], ['--background']]) {
          const output = runDryRun([slot, '--open-only', ...background], { ...env, PGREP_STATUS: '0' });
          expect(output).toContain('would run');
          expect(output).not.toContain('CODE_AGENT_FRESH_USER');
        }
      }
      expect(existsSync(env.PGREP_ARGS!)).toBe(false);
    });
  });

  it('advertises the fresh flag after dry-run in usage', () => {
    withStub((env) => {
      try {
        runDryRun(['--unknown'], env);
        expect.fail('invalid arguments must fail');
      } catch (error) {
        expect(outputText((error as { stderr?: unknown }).stderr)).toMatch(/Usage: .*--dry-run.*--fresh-user/);
      }
    });
  });
});
