// ============================================================================
// Managed LibreOffice shell hook（N-ENV-ASSIST-S5-RUNTIME）
//
// 真 lookup / state / layout / errors，数据目录用 CODE_AGENT_DATA_DIR 指到临时目录；
// 只有 ensureLibreOffice 打桩（真装要联网下 ~300MB，单测禁止）。经生产入口
// createEvalSafeShellEnv 进（bash 前台/后台/PTY 三条路径共用），不直接碰内部函数。
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/host/runtime/libreOffice/ensure', () => ({
  ensureLibreOffice: vi.fn(),
}));

import { ensureLibreOffice } from '../../../../../src/host/runtime/libreOffice/ensure';
import { offlineError } from '../../../../../src/host/runtime/libreOffice/errors';
import { resolveLibreOfficeRoot } from '../../../../../src/host/runtime/libreOffice/layout';
import { clearInflight, clearInstallPercent, forgetError, rememberError, setInflight, setInstallPercent } from '../../../../../src/host/runtime/libreOffice/state';
import { createEvalSafeShellEnv } from '../../../../../src/host/tools/modules/shell/evalSafeShellEnv';
import { parkMissingRuntime } from '../../../../../src/host/agent/runtime/runtimeMissingTurn';

const ensureMock = vi.mocked(ensureLibreOffice);
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

let dataDir = '';
let managedRoot = '';
let managedDir = '';
const run = (command: string, pathEnv?: string) => createEvalSafeShellEnv({ PATH: pathEnv ?? '/usr/bin:/bin' }, '/tmp/project', undefined, { allowNetwork: false, command });

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-lo-env-'));
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
  managedRoot = resolveLibreOfficeRoot();
  managedDir = path.join(managedRoot, 'LibreOffice.app', 'Contents', 'MacOS');
  vi.stubEnv('CODE_AGENT_NO_RUNTIME_AUTOINSTALL', '1');
  // 这台开发机自己装了 LibreOffice：默认开 managed-only 缝，测试才与机器无关（真缺 LibreOffice 的机器）。
  vi.stubEnv('CODE_AGENT_LIBREOFFICE_MANAGED_ONLY', '1');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  ensureMock.mockReset();
  ensureMock.mockImplementation(() => { setInflight(managedRoot, new Promise(() => {})); return new Promise(() => {}); });
});

afterEach(() => {
  clearInflight(managedRoot); clearInstallPercent(managedRoot); forgetError(managedRoot);
  vi.unstubAllEnvs();
  process.env.CODE_AGENT_NO_RUNTIME_AUTOINSTALL = '1';
  delete process.env.CODE_AGENT_LIBREOFFICE_MANAGED_ONLY;
  Object.defineProperty(process, 'platform', platformDescriptor);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** 摆出已装现场：ready.json 字段齐全 + Contents/MacOS/soffice 可执行。 */
function installManaged(): string {
  fs.mkdirSync(managedDir, { recursive: true });
  const soffice = path.join(managedDir, 'soffice');
  fs.writeFileSync(soffice, '#!/bin/sh\necho fake soffice\n', { mode: 0o755 });
  fs.writeFileSync(path.join(managedRoot, 'ready.json'), JSON.stringify({
    version: 'test', arch: 'arm64', sha256: 'a'.repeat(64), sourceUrl: 'https://example.test/lo.dmg', installedAt: '2026-11-26T00:00:00.000Z',
  }));
  return soffice;
}

describe('token match: only soffice / libreoffice run as a program', () => {
  it.each([
    'echo "soffice --headless --convert-to pdf deck.pptx"',
    'echo soffice',
    "echo 'a; soffice b'",
    'which soffice || echo none',
    'command -v soffice',
    'command -V libreoffice',
    'command -pv soffice',
    'if command -v soffice >/dev/null 2>&1; then echo have; else echo "no soffice"; fi',
    "cat <<'EOF'\nsoffice --headless --convert-to pdf deck.pptx\nEOF",
    'cat > run.sh <<EOF\nsoffice --headless\nEOF\nbash run.sh',
    '# soffice --headless\nls',
    'ls | grep soffice',
    "alias soffice='echo no'",
    'export SOFFICE=/x/soffice',
    "bash -c 'soffice --headless'",
    'git commit -m "fix soffice"',
    'pkill soffice',
    'open -a LibreOffice deck.pptx',
    'case $x in a) soffice ;; esac',
    "trap 'soffice' EXIT",
    'echo "$(which soffice)"',
    'python3 -c "import subprocess; subprocess.run([\'soffice\'])"',
    'jq -r \'.name\' <<< \'{"name":"soffice"}\'',
    'array=(soffice libreoffice); echo "${array[0]}"',
  ])('does not touch the env for %j', (command) => {
    const assemble = (text: string) => createEvalSafeShellEnv({ PATH: '/usr/bin:/bin', HOME: '/Users/example', LANG: 'en_US.UTF-8' }, '/tmp/project', undefined, { allowNetwork: false, command: text });
    const result = assemble(command);
    expect(result.ok).toBe(true);
    // 逐键逐值与一条不含 soffice 的命令一致：没有被改写的 PATH，也没有多出来的变量。
    const plain = assemble('true');
    expect(result.ok && result.env).toEqual(plain.ok && plain.env);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it.each([
    'soffice --headless --convert-to pdf --outdir out deck.pptx',
    'cd Downloads && for f in *.pptx; do soffice --headless --convert-to pdf --outdir out "$f"; done',
    'libreoffice --headless --convert-to pdf a.docx && soffice --version',
    'time soffice --version',
    'nohup soffice --headless --convert-to pdf a.pptx > /dev/null 2>&1 &',
    'env HOME=/tmp soffice --headless',
    'PATH=/opt/lo/bin:$PATH soffice --headless',
    'result=$(soffice --version) && echo "$result"',
    '2>/dev/null soffice --headless',
    '(cd d && soffice --headless)',
    '{ soffice --headless; }',
    'sudo -- soffice --headless',
    'sudo -n soffice --headless',
    'while IFS= read -r f; do soffice --headless "$f"; done < list.txt',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice --headless --convert-to pdf deck.pptx',
    '"/Applications/LibreOffice.app/Contents/MacOS/soffice" --convert-to pdf "$f"',
    'soffice --headless \\\n  --convert-to pdf',
    '! command -v soffice &>/dev/null && echo missing || soffice --headless',
  ])('refuses to run %j while nothing is installed', (command) => {
    const result = run(command);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('LIBREOFFICE_RUNTIME_INSTALLING');
      expect(result.envBlocked).toEqual({ class: 'runtime_missing', target: 'libreoffice' });
      expect(result.waitable).toBe(true);
    }
  });
});

describe('missing: fail closed with plain guidance', () => {
  it('says the command was not run and that it is being prepared; never a system error text', () => {
    const result = run('soffice --headless --convert-to pdf deck.pptx');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      console.log('MISSING_RESULT', JSON.stringify(result));
      expect(result.error).toContain('This command was not run');
      expect(result.error).toContain('preparing LibreOffice');
      expect(result.error).not.toMatch(/ENOENT|not found|Command failed|Error:/);
    }
    // CODE_AGENT_NO_RUNTIME_AUTOINSTALL=1 (the test suite default): no download is started.
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('starts one background install (single flight) and reports the live percent', () => {
    vi.stubEnv('CODE_AGENT_NO_RUNTIME_AUTOINSTALL', '0');
    const command = 'soffice --headless --convert-to pdf deck.pptx';
    run(command);
    expect(ensureMock).toHaveBeenCalledTimes(1);
    setInstallPercent(managedRoot, 42);
    const again = run(command);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain('42% done');
    expect(ensureMock).toHaveBeenCalledTimes(1);
  });

  it('a failed install keeps the stable reason code and says where the retry button is', () => {
    rememberError(managedRoot, offlineError(managedRoot));
    const result = run('soffice --headless --convert-to pdf deck.pptx');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      console.log('FAILED_RESULT', JSON.stringify(result));
      expect(result.code).toBe('LIBREOFFICE_RUNTIME_OFFLINE');
      expect(result.waitable).toBe(true);
      expect(result.error).toContain('retry button');
      expect(result.error).toContain('unreachable');
    }
  });

  it('a system without the managed runtime says so and is not worth waiting for', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.stubEnv('CODE_AGENT_NO_RUNTIME_AUTOINSTALL', '0');
    const result = run('soffice --headless --convert-to pdf deck.pptx');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      console.log('UNSUPPORTED_RESULT', JSON.stringify(result));
      expect(result.code).toBe('LIBREOFFICE_RUNTIME_UNSUPPORTED');
      expect(result.waitable).toBe(false);
    }
    expect(ensureMock).not.toHaveBeenCalled();
  });
});

describe('installed: the managed directory goes to the end of PATH, nothing else moves', () => {
  it('appends once, never prepends, and leaves every other entry and variable byte-identical', () => {
    installManaged();
    const baseline = createEvalSafeShellEnv({ PATH: '/usr/bin:/bin', HOME: '/Users/example' }, '/tmp/project', undefined, {
      allowNetwork: false, command: 'echo ok',
    });
    const result = createEvalSafeShellEnv({ PATH: '/usr/bin:/bin', HOME: '/Users/example' }, '/tmp/project', undefined, {
      allowNetwork: false, command: 'soffice --headless --convert-to pdf deck.pptx',
    });
    expect(baseline.ok && result.ok).toBe(true);
    if (baseline.ok && result.ok) {
      expect(result.env.PATH).toBe(`/usr/bin:/bin${path.delimiter}${managedDir}`);
      expect(result.env.HOME).toBe('/Users/example');
      // …and LibreOffice is pointed at the two places the Bash sandbox lets it use (nothing else is added).
      const added = Object.keys(result.env).filter((key) => !(key in baseline.env)).sort();
      expect(added).toEqual(['OSL_SOCKET_PATH', 'UserInstallation']);
      expect(result.env.OSL_SOCKET_PATH).toBe('/private/tmp');
      expect(result.env.UserInstallation).toMatch(/^file:\/\/.*\/neo-libreoffice-profile$/);
    }
    const twice = run(`PATH="/usr/bin:/bin:${managedDir}" true; soffice --version`, `/usr/bin:/bin${path.delimiter}${managedDir}`);
    expect(twice.ok && twice.env.PATH).toBe(`/usr/bin:/bin${path.delimiter}${managedDir}`);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('does not append for commands that do not run soffice / libreoffice', () => {
    installManaged();
    const result = run('echo "soffice" && which soffice');
    expect(result.ok && result.env.PATH).toBe('/usr/bin:/bin');
    expect(result.ok && result.env.UserInstallation).toBeUndefined();
  });

  it('leaves values the caller already set alone, and still prepares the env when the managed dir is already on PATH', () => {
    installManaged();
    const result = createEvalSafeShellEnv({ PATH: `${managedDir}${path.delimiter}/usr/bin`, UserInstallation: 'file:///Users/example/my-profile', OSL_SOCKET_PATH: '/Users/example/sockets' }, '/tmp/project', undefined, {
      allowNetwork: false, command: 'libreoffice --headless --convert-to pdf a.docx',
    });
    expect(result.ok && result.env).toMatchObject({ PATH: `${managedDir}${path.delimiter}/usr/bin`, UserInstallation: 'file:///Users/example/my-profile', OSL_SOCKET_PATH: '/Users/example/sockets' });
  });

  it('does not prepare the env when a soffice somewhere else on PATH answers (that copy is not this hook\'s)', () => {
    installManaged();
    const otherBin = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-lo-other-'));
    fs.writeFileSync(path.join(otherBin, 'soffice'), '#!/bin/sh\n', { mode: 0o755 });
    delete process.env.CODE_AGENT_LIBREOFFICE_MANAGED_ONLY;
    try {
      const result = run('soffice --version', `/usr/bin${path.delimiter}${otherBin}${path.delimiter}/bin`);
      expect(result.ok && result.env.UserInstallation).toBeUndefined();
    } finally {
      fs.rmSync(otherBin, { recursive: true, force: true });
    }
  });

  it('a PATH-less environment gets exactly the managed directory', () => {
    installManaged();
    const result = createEvalSafeShellEnv({ PATH: '' }, '/tmp/project', undefined, { allowNetwork: false, command: 'libreoffice --version' });
    expect(result.ok && result.env.PATH).toBe(managedDir);
  });
});

describe('managed-only seam (CODE_AGENT_LIBREOFFICE_MANAGED_ONLY=1, the suite default here)', () => {
  it('a system soffice on PATH and /Applications do not count while the seam is on', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-lo-bin-'));
    fs.writeFileSync(path.join(bin, 'soffice'), '#!/bin/sh\n', { mode: 0o755 });
    try {
      const result = run('soffice --headless --convert-to pdf deck.pptx', `${bin}:/usr/bin:/bin`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('LIBREOFFICE_RUNTIME_INSTALLING');
      delete process.env.CODE_AGENT_LIBREOFFICE_MANAGED_ONLY;
      expect(run('soffice --headless --convert-to pdf deck.pptx', `${bin}:/usr/bin:/bin`).ok).toBe(true);
    } finally { fs.rmSync(bin, { recursive: true, force: true }); }
  });

  it('the fixed application path counts only while the seam is off and the file is really there', () => {
    const command = '/Applications/LibreOffice.app/Contents/MacOS/soffice --version';
    const onThisMachine = fs.existsSync('/Applications/LibreOffice.app/Contents/MacOS/soffice');
    vi.stubEnv('CODE_AGENT_LIBREOFFICE_MANAGED_ONLY', '0');
    const seamOff = run(command);
    console.log('FIXED_PATH_SEAM_OFF', JSON.stringify({ onThisMachine, ok: seamOff.ok, code: seamOff.ok ? undefined : seamOff.code }));
    if (onThisMachine) expect(seamOff.ok).toBe(true);
    else if (!seamOff.ok) expect(seamOff.code).toBe('LIBREOFFICE_RUNTIME_INSTALLING');
    vi.stubEnv('CODE_AGENT_LIBREOFFICE_MANAGED_ONLY', '1');
    const seamOn = run(command);
    expect(seamOn.ok).toBe(false);
    if (!seamOn.ok) expect(seamOn.code).toBe('LIBREOFFICE_RUNTIME_INSTALLING');
  });
});

describe('parkMissingRuntime: the Bash module asks whether this run can wait', () => {
  // The positive side (a parkable run throws the blocker and parks) is proven through the real Bash tool and engine in
  // tests/unit/host/runtime/envResumeLibreOffice.test.ts; here only the pass-through shapes.
  const refusal = { ok: false as const, code: 'LIBREOFFICE_RUNTIME_INSTALLING' as const, envBlocked: { class: 'runtime_missing' as const, target: 'libreoffice' }, waitable: true };
  it('keeps the fail-closed result for a run that cannot park (no run, unknown run, no call id)', () => {
    expect(() => parkMissingRuntime(refusal, { runId: undefined, currentToolCallId: 'c1' })).not.toThrow();
    expect(() => parkMissingRuntime(refusal, { runId: 'no-such-run', currentToolCallId: 'c1' })).not.toThrow();
    expect(() => parkMissingRuntime(refusal, { runId: 'no-such-run' })).not.toThrow();
  });
  it('never parks for a refusal that is not worth waiting for', () => {
    expect(() => parkMissingRuntime({ ...refusal, waitable: false }, { runId: 'no-such-run', currentToolCallId: 'c1' })).not.toThrow();
    expect(() => parkMissingRuntime({ ok: false, code: 'ENV_SECRET_UNRESOLVED' }, { runId: 'no-such-run', currentToolCallId: 'c1' })).not.toThrow();
  });
});
