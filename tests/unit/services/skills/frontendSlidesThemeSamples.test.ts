// 风格样张脚本 + SKILL.md 选风格步骤（N-PPT-SAMPLE-PICK-FLOW）。
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { quote } from 'shell-quote';
import { wrapCommandForSandbox } from '../../../../src/host/sandbox/manager';
import { resolveSandboxNetworkPolicy } from '../../../../src/host/sandbox/networkPolicy';
import { generateProfile, type SeatbeltConfig } from '../../../../src/host/sandbox/seatbelt';

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found');
}

const root = repoRoot();
const script = path.join(root, 'resources', 'skills', 'frontend-slides', 'scripts', 'theme-samples.mjs');

const SLIDES = [
  { index: 1, layout: 'cover', title: 'Q3 季度报告', subtitle: '增长稳健', bullets: [], footnote: '' },
  { index: 2, layout: 'content', title: '营收同比增长 23%', subtitle: '', bullets: ['华东贡献最大', '新客占比 41%'], footnote: '' },
];

function makeDeck(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-samples-'));
  fs.writeFileSync(path.join(dir, 'slides.json'), JSON.stringify(SLIDES), 'utf8');
  return dir;
}

function run(deck: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script, deck], { encoding: 'utf8', env, timeout: 180_000 });
}

function hasSoffice(): boolean {
  const candidates = [
    process.env.LIBREOFFICE_PATH,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/libreoffice',
  ].filter((entry): entry is string => Boolean(entry));
  if (candidates.some((entry) => fs.existsSync(entry))) return true;
  return ['soffice', 'libreoffice'].some((bin) => spawnSync('which', [bin]).status === 0);
}

const SOFFICE = hasSoffice();

describe('frontend-slides theme-samples script', () => {
  // 没有 LibreOffice 的机器上这条显式跳过（原因写在用例名里），不静默通过。
  it.skipIf(!SOFFICE)('emits 3 distinct non-empty PNGs for corporate/minimal/bold-editorial', () => {
    const deck = makeDeck();
    const env = { ...process.env };
    delete env.NODE_PATH;
    const result = run(deck, env);
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.available).toBe(true);
    expect(out.slide).toBe(2);
    expect(out.samples.map((s: { theme: string }) => s.theme)).toEqual(['corporate', 'minimal', 'bold-editorial']);
    const hashes = out.samples.map((s: { png: string }) => {
      expect(path.isAbsolute(s.png)).toBe(true);
      const bytes = fs.readFileSync(s.png);
      expect(bytes.length).toBeGreaterThan(0);
      return createHash('sha256').update(bytes).digest('hex');
    });
    expect(new Set(hashes).size).toBe(3);
  }, 240_000);

  // 假 soffice：把收到的 pptx 抄到捕获目录再失败。不依赖真 LibreOffice，直接检查样张 PPTX 的版式。
  function capturedSamplePptx(deckSlides: unknown[]): string[] {
    const deck = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-samples-cap-'));
    fs.writeFileSync(path.join(deck, 'slides.json'), JSON.stringify(deckSlides), 'utf8');
    const capture = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-samples-capdir-'));
    const fake = path.join(capture, 'fake-soffice');
    fs.writeFileSync(fake, `#!/bin/sh\nfor last; do :; done\ncp "$last" "${capture}/$(basename "$last")"\nexit 1\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, LIBREOFFICE_PATH: fake };
    delete env.NODE_PATH;
    run(deck, env);
    return fs.readdirSync(capture).filter((f) => f.endsWith('.pptx')).map((f) => path.join(capture, f));
  }
  const titleCentered = (pptx: string) =>
    spawnSync('unzip', ['-p', pptx, 'ppt/slides/slide1.xml'], { encoding: 'utf8' }).stdout.includes('algn="ctr"');

  it('lays a chosen content slide out as content, not as a cover (merge treats index 1 as cover)', () => {
    const pptxs = capturedSamplePptx(SLIDES);
    expect(pptxs.length).toBe(1); // fake soffice fails after the first theme
    expect(titleCentered(pptxs[0])).toBe(false);
  });

  it('still lays a sole cover slide out as a cover', () => {
    const pptxs = capturedSamplePptx([SLIDES[0]]);
    expect(pptxs.length).toBe(1);
    expect(titleCentered(pptxs[0])).toBe(true);
  });

  it('prints {available:false}, exits 0 and logs the failed lookup when soffice cannot be found', () => {
    const deck = makeDeck();
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'no-soffice-'));
    // 显式 LIBREOFFICE_PATH 是权威来源：指向不存在的文件 = 本机视为没装，即使系统别处装了 LibreOffice。
    const result = run(deck, { PATH: emptyBin, LIBREOFFICE_PATH: path.join(emptyBin, 'soffice') });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ available: false, reason: 'LibreOffice (soffice) not found' });
    expect(result.stderr).toContain('lookup failed');
  });
});

describe('frontend-slides theme-samples diagnostics and sandbox', () => {
  function fakeSoffice(body: string) {
    const deck = makeDeck();
    const fake = path.join(deck, 'fake-soffice');
    fs.writeFileSync(fake, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { deck, fake };
  }

  it.each([
    ['stderr tail', 'echo conversion-broke >&2; echo conversion-output; exit 7', 'soffice render failed', 'conversion-broke', '"status":7'],
    ['empty stderr', 'exit 1', 'soffice render failed', '"stderr":""', '"status":1'],
    ['signal', 'kill -TERM $$', 'soffice render failed', '"signal":"SIGTERM"', '"status":null'],
    // stderr text is not evidence of a denial: a real one never reaches the child's stderr.
    ['denial-looking stderr', 'echo "Sandbox: soffice deny(1) file-write-create /blocked" >&2; exit 1', 'soffice render failed', 'file-write-create /blocked', '"status":1'],
  ])('soffice non-zero reports %s and a distinct reason', (_name, body, reason, tail, status) => {
    const { deck, fake } = fakeSoffice(body);
    try {
      const result = run(deck, { ...process.env, LIBREOFFICE_PATH: fake });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toEqual({ available: false, reason });
      expect(result.stderr).toContain(tail);
      expect(result.stderr).toContain(status);
      expect(result.stderr).toContain('"error":null');
      expect(result.stderr).toContain('"signal":');
      if (body.includes('conversion-output')) expect(result.stderr).toContain('conversion-output');
    } finally {
      fs.rmSync(deck, { recursive: true, force: true });
    }
  });

  it('includes spawn errors when an executable has a missing interpreter', () => {
    const { deck, fake } = fakeSoffice('exit 0');
    fs.writeFileSync(fake, '#!/nonexistent-theme-samples-interpreter\n');
    try {
      const result = run(deck, { ...process.env, LIBREOFFICE_PATH: fake });
      expect(JSON.parse(result.stdout)).toEqual({ available: false, reason: 'soffice render failed' });
      const details = JSON.parse(result.stderr.slice(result.stderr.indexOf('{"status"')));
      expect(details.status).toBe(null);
      expect(details.signal).toBe(null);
      expect(details.error).toContain('ENOENT');
      expect(details.stderr).toBe('');
    } finally {
      fs.rmSync(deck, { recursive: true, force: true });
    }
  });

  it('caps both stderr and stdout diagnostics at 500 characters', () => {
    const { deck, fake } = fakeSoffice(`echo '${'e'.repeat(600)}' >&2; echo '${'o'.repeat(600)}'; exit 1`);
    try {
      const result = run(deck, { ...process.env, LIBREOFFICE_PATH: fake });
      const details = JSON.parse(result.stderr.slice(result.stderr.indexOf('{"status"')));
      expect(details.stderr).toBe('e'.repeat(500));
      expect(details.stdout).toBe('o'.repeat(500));
    } finally {
      fs.rmSync(deck, { recursive: true, force: true });
    }
  });

  it('distinguishes pdf-to-png failure from soffice failure', () => {
    const { deck, fake } = fakeSoffice('exit 0');
    const converter = path.join(deck, 'pdftoppm');
    fs.writeFileSync(converter, '#!/bin/sh\necho png-converter-broke >&2\nexit 9\n', { mode: 0o755 });
    try {
      const result = run(deck, { ...process.env, LIBREOFFICE_PATH: fake, PATH: `${deck}${path.delimiter}${process.env.PATH}` });
      expect(JSON.parse(result.stdout)).toEqual({ available: false, reason: 'pdf-to-png failed' });
      expect(result.stderr).toContain('png-converter-broke');
      expect(result.stderr).toContain('"status":9');
    } finally {
      fs.rmSync(deck, { recursive: true, force: true });
    }
  });

  it('places the profile and conversion output within generateProfile writable roots', () => {
    const { deck, fake } = fakeSoffice('for arg; do echo "$arg" >&2; done; exit 1');
    try {
      const result = run(deck, { ...process.env, LIBREOFFICE_PATH: fake });
      const details = JSON.parse(result.stderr.slice(result.stderr.indexOf('{"status"')));
      const args = details.stderr.trim().split('\n') as string[];
      const profile = fileURLToPath(args.find((arg) => arg.startsWith('-env:UserInstallation='))!.slice('-env:UserInstallation='.length));
      const output = args[args.indexOf('--outdir') + 1];
      const config: SeatbeltConfig = {
        allowNetwork: false, readPaths: [], writePaths: [deck], executePaths: [],
        allowProcessExec: true, allowProcessFork: true, envPassthrough: [], customEnv: {},
        workingDirectory: deck, allowWorkingDirectoryWrite: false, sensitivePaths: [],
      };
      const roots = [...generateProfile(config).matchAll(/\(allow file-write\* \(subpath "([^"]+)"\)\)/g)].map((match) => match[1]);
      for (const target of [profile, output, path.join(deck, 'theme-samples')]) {
        // The work tree is already removed by the script; canonicalize its surviving parent.
        const canonical = path.join(fs.realpathSync(os.tmpdir()), path.relative(os.tmpdir(), target));
        expect(roots.some((root) => canonical.startsWith(`${root}/`)), target).toBe(true);
      }
    } finally {
      fs.rmSync(deck, { recursive: true, force: true });
    }
  });

  const SANDBOX = process.platform === 'darwin' && spawnSync('which', ['sandbox-exec']).status === 0;

  // The wrapper Bash uses: script, soffice and the script's own probes all run inside the real profile.
  function runSandboxed(deck: string, argv: string[], env: NodeJS.ProcessEnv = process.env) {
    const command = quote([process.execPath, ...argv]);
    const wrapped = wrapCommandForSandbox(command, {
      workingDirectory: deck, allowNetwork: resolveSandboxNetworkPolicy({ command }),
    });
    try {
      return spawnSync('/bin/sh', ['-c', wrapped.command], { cwd: deck, encoding: 'utf8', env, timeout: 180_000 });
    } finally {
      wrapped.cleanup();
    }
  }
  // Not under any write root of the profile (those are TMPDIR, the deck and /dev).
  const outsideRoots = (name: string) => `/private/tmp/theme-samples-${name}-${process.pid}`;

  it.skipIf(!SANDBOX || !SOFFICE)('real Bash sandbox wrapper renders 3 non-empty PNGs', () => {
    const deck = makeDeck();
    try {
      const result = runSandboxed(deck, [script, deck]);
      expect(result.status, result.stderr).toBe(0);
      const out = JSON.parse(result.stdout.trim());
      expect(out.available, result.stderr).toBe(true);
      expect(out.samples.map((sample: { theme: string }) => sample.theme)).toEqual(['corporate', 'minimal', 'bold-editorial']);
      for (const sample of out.samples) expect(fs.statSync(sample.png).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(deck, { recursive: true, force: true });
    }
  }, 240_000);

  it.skipIf(!SANDBOX)('real sandbox: a conversion failure with nothing denied stays "soffice render failed"', () => {
    const { deck, fake } = fakeSoffice('echo conversion-broke >&2; exit 7');
    try {
      const result = runSandboxed(deck, [script, deck], { ...process.env, LIBREOFFICE_PATH: fake });
      expect(JSON.parse(result.stdout), result.stderr).toEqual({ available: false, reason: 'soffice render failed' });
      expect(result.stderr).toContain('conversion-broke');
      expect(result.stderr).not.toContain('probe failed');
    } finally {
      fs.rmSync(deck, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!SANDBOX)('real sandbox: an output directory the script may not create is "sandbox denied write"', () => {
    const { deck, fake } = fakeSoffice('exit 0');
    const out = outsideRoots('nodir');
    try {
      const result = runSandboxed(deck, [script, deck, '--out', out], { ...process.env, LIBREOFFICE_PATH: fake });
      expect(JSON.parse(result.stdout), result.stderr).toEqual({ available: false, reason: 'sandbox denied write' });
      expect(result.stderr).toContain(`EPERM: operation not permitted, mkdir '${out}'`);
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
      fs.rmSync(deck, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!SANDBOX || !SOFFICE)('real sandbox: an existing output directory outside the write roots is "sandbox denied write"', () => {
    const deck = makeDeck();
    const out = outsideRoots('rodir');
    fs.mkdirSync(out);
    try {
      const result = runSandboxed(deck, [script, deck, '--out', out]);
      expect(JSON.parse(result.stdout), result.stderr).toEqual({ available: false, reason: 'sandbox denied write' });
      expect(result.stderr).toContain(`probe failed: write ${out} -> EPERM`);
      expect(fs.readdirSync(out)).toEqual([]);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
      fs.rmSync(deck, { recursive: true, force: true });
    }
  }, 240_000);

  // Real soffice, real profile, real denial: without the socket-directory flag LibreOffice binds
  // /OSL_PIPE_* at the filesystem root, the kernel refuses, and soffice exits 1 printing nothing.
  it.skipIf(!SANDBOX || !SOFFICE)('real sandbox: soffice denied its IPC socket is "sandbox denied socket", not a render failure', () => {
    const deck = makeDeck();
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-samples-noflag-'));
    try {
      for (const file of ['merge-to-pptx-hybrid.mjs', 'merge-to-pptx-hybrid.bundle.mjs']) {
        fs.copyFileSync(path.join(path.dirname(script), file), path.join(copy, file));
      }
      const source = fs.readFileSync(script, 'utf8');
      const withoutFlag = source.replace("? '/private/tmp' : ''", "? '' : ''");
      expect(withoutFlag).not.toBe(source);
      fs.writeFileSync(path.join(copy, 'theme-samples.mjs'), withoutFlag);

      const result = runSandboxed(deck, [path.join(copy, 'theme-samples.mjs'), deck]);
      expect(JSON.parse(result.stdout), result.stderr).toEqual({ available: false, reason: 'sandbox denied socket' });
      expect(result.stderr).toMatch(/probe failed: socket \/OSL_PIPE_\d+_SingleOfficeIPC_probe\d+ -> EPERM/);
      expect(result.stderr).toContain('soffice (corporate) failed: {"status":1,"signal":null,"error":null,"stderr":"","stdout":""}');
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
      fs.rmSync(deck, { recursive: true, force: true });
    }
  }, 240_000);
});

describe('frontend-slides SKILL.md sample-pick step', () => {
  const copies = [
    'resources/skills/frontend-slides/SKILL.md',
    '.claude/skills/frontend-slides/SKILL.md',
    '.agents/skills/frontend-slides/SKILL.md',
  ];

  it.each(copies)('%s documents the sample step, skip rules and theme hand-off', (relative) => {
    const content = fs.readFileSync(path.join(root, relative), 'utf8');
    expect(content).toContain('### 3.5 风格样张');
    expect(content).toContain('theme-samples.mjs');
    // 跳过规则
    expect(content).toContain('「直接做」「just do it」「you decide」');
    expect(content).toContain('用户已经点名了风格');
    // 无 LibreOffice 的文字降级
    expect(content).toContain('available:false');
    expect(content).toContain('这台机器没有预览');
    // 选择结果交给第 5 步 --theme
    expect(content).toContain('第 5 步的 `--theme` 就传这个值');
    // 样张步骤位于 slides.json 与合成之间
    const order = ['### 3. 生成 slides.json', '### 3.5 风格样张', '### 5. 合成 PPTX / PDF'].map((h) => content.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
