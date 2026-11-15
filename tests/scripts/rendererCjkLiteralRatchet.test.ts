import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scriptPath = resolve('scripts/renderer-cjk-literal-ratchet.mjs');

describe('renderer-cjk-literal-ratchet', () => {
  let repoRoot: string;
  let rendererRoot: string;
  let contractRoot: string;
  let baselinePath: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'renderer-cjk-literal-ratchet-'));
    rendererRoot = join(repoRoot, 'src/renderer/components');
    contractRoot = join(repoRoot, 'src/shared/contract');
    baselinePath = join(repoRoot, 'scripts/renderer-cjk-literal-baseline.json');
    mkdirSync(rendererRoot, { recursive: true });
    mkdirSync(contractRoot, { recursive: true });
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function runCli(extraArgs: string[] = [], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [scriptPath, '--repo-root', repoRoot, ...extraArgs], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  }

  function git(...args: string[]) {
    const res = spawnSync(
      'git',
      ['-C', repoRoot, '-c', 'user.name=ratchet-test', '-c', 'user.email=ratchet-test@example.invalid', ...args],
      { encoding: 'utf8' },
    );
    expect(res.status, res.stderr).toBe(0);
  }

  function commitAll(message: string) {
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', message);
  }

  function writeBaseline(files: Record<string, number | { count: number; reason?: string }>) {
    writeFileSync(
      baselinePath,
      JSON.stringify({ schemaVersion: 1, files }, null, 2),
      'utf8',
    );
  }

  it('scans renderer JSX text + JSX attribute strings (excluding i18n/tests/.d.ts) and contract strings/templates', () => {
    writeFileSync(
      join(rendererRoot, 'Sample.tsx'),
      [
        'import React from "react";',
        'const nonRenderedTable = "普通字符串不计入";',
        'export function Sample({ count, isZh }: { count: number; isZh: boolean }) {',
        '  return (',
        '    <div aria-label="中文属性" data-testid="en-only">',
        '      <span>中文文本</span>',
        '      <input placeholder="请输入内容" />',
        "      <input placeholder={'花括号包一层的属性'} title={`共 ${count} 行`} />",
        "      <p>{'花括号包一层的文本'}</p>",
        "      <p>{isZh ? '三元里的中文不计入' : 'English'}</p>",
        '      <p title={nonRenderedTable}>{nonRenderedTable}</p>',
        '    </div>',
        '  );',
        '}',
      ].join('\n'),
      'utf8',
    );
    mkdirSync(join(repoRoot, 'src/renderer/i18n'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'src/renderer/i18n/zh.ts'),
      'export const zh = { greeting: "语言包中文应被排除" };\n',
      'utf8',
    );
    writeFileSync(
      join(rendererRoot, 'Sample.test.tsx'),
      'export const t = () => <div>测试中文应被排除</div>;\n',
      'utf8',
    );
    writeFileSync(
      join(rendererRoot, 'types.d.ts'),
      'export type T = "类型声明中文应被排除";\n',
      'utf8',
    );
    writeFileSync(
      join(contractRoot, 'privacy.ts'),
      [
        'export const TITLE = "隐私与数据边界";',
        'export const DESC = (n: number) => `共 ${n} 项说明`;',
        'export const EN_ONLY = "English contract string";',
      ].join('\n'),
      'utf8',
    );

    writeBaseline({
      'src/renderer/components/Sample.tsx': 6,
      'src/shared/contract/privacy.ts': 2,
    });

    const res = runCli();
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('src/renderer/components/Sample.tsx: current=6 baseline=6');
    expect(res.stdout).toContain('src/shared/contract/privacy.ts: current=2 baseline=2');
    expect(res.stdout).toContain('未做手工上调比对');

    // 基线清零后，被计入的 6 处逐条按 file:line 点名；三元和变量引用那两行不出现
    writeBaseline({ 'src/shared/contract/privacy.ts': 2 });
    const named = runCli();
    expect(named.status).toBe(1);
    for (const line of [5, 6, 7, 8, 9]) {
      expect(named.stderr).toContain(`src/renderer/components/Sample.tsx:${line}:`);
    }
    expect(named.stderr).not.toContain('src/renderer/components/Sample.tsx:10:');
    expect(named.stderr).not.toContain('src/renderer/components/Sample.tsx:11:');
    expect(named.stderr).not.toContain('src/renderer/components/Sample.tsx:2:');
  });

  it('ratchet-down check: fails on new file or raised count, refuses --update-baseline upward, allows lowering', () => {
    const samplePath = join(rendererRoot, 'Existing.tsx');
    const contractFile = join(contractRoot, 'boundary.ts');
    writeFileSync(
      samplePath,
      'export const Existing = () => <div title="标题一">正文二</div>;\n',
      'utf8',
    );
    writeFileSync(contractFile, 'export const BOUNDARY = "既有边界文案";\n', 'utf8');
    writeBaseline({
      'src/renderer/components/Existing.tsx': 2,
      'src/shared/contract/boundary.ts': 1,
    });

    expect(runCli().status).toBe(0);

    // 1) Adding a new renderer file with JSX text + placeholder fails with file:line
    const addedPath = join(rendererRoot, 'Added.tsx');
    writeFileSync(
      addedPath,
      'export const Added = () => <div><span>新增中文</span><input placeholder="输入提示" /></div>;\n',
      'utf8',
    );
    const failedNewFile = runCli();
    expect(failedNewFile.status).toBe(1);
    expect(failedNewFile.stderr).toContain('src/renderer/components/Added.tsx:1:');

    // 2) Running --update-baseline when count is higher than baseline refuses to raise
    const failedUpdateUp = runCli(['--update-baseline']);
    expect(failedUpdateUp.status).toBe(1);
    expect(failedUpdateUp.stderr).toContain('--update-baseline 拒绝上调基线或新增命中文件');

    unlinkSync(addedPath);
    expect(runCli().status).toBe(0);

    // 3) Adding a CJK literal to an existing contract file fails
    writeFileSync(
      contractFile,
      'export const BOUNDARY = "既有边界文案";\nexport const EXTRA = "新增契约中文";\n',
      'utf8',
    );
    const failedContract = runCli();
    expect(failedContract.status).toBe(1);
    expect(failedContract.stderr).toContain('src/shared/contract/boundary.ts:2:');
    expect(runCli(['--update-baseline']).status).toBe(1);

    // 4) Lowering count in Existing.tsx (2 -> 0) and running --update-baseline lowers/removes entry
    writeFileSync(contractFile, 'export const BOUNDARY = "既有边界文案";\n', 'utf8');
    writeFileSync(
      samplePath,
      'export const Existing = () => <div title={t.title}>{t.body}</div>;\nconst t = { title: "Title", body: "Body" };\n',
      'utf8',
    );
    const loweredCheck = runCli();
    expect(loweredCheck.status).toBe(1);
    expect(loweredCheck.stderr).toContain('基线过期');
    expect(loweredCheck.stderr).toContain('src/renderer/components/Existing.tsx: current=0 < baseline=2');

    const updated = runCli(['--update-baseline']);
    expect(updated.status, updated.stderr).toBe(0);
    const saved = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      files: Record<string, unknown>;
    };
    expect(saved.files['src/renderer/components/Existing.tsx']).toBeUndefined();
    expect(saved.files['src/shared/contract/boundary.ts']).toBe(1);
    expect(runCli().status).toBe(0);

    // 4b) Raising a count by hand (no new literal) leaves the baseline above reality and fails
    writeBaseline({ 'src/shared/contract/boundary.ts': 2 });
    const handRaised = runCli();
    expect(handRaised.status).toBe(1);
    expect(handRaised.stderr).toContain('src/shared/contract/boundary.ts: current=1 < baseline=2');
    writeBaseline({ 'src/shared/contract/boundary.ts': 1 });

    // 5) Re-introducing Chinese after baseline lowered now fails against the tightened baseline
    writeFileSync(samplePath, 'export const Existing = () => <div>回归中文</div>;\n', 'utf8');
    const regressed = runCli();
    expect(regressed.status).toBe(1);
    expect(regressed.stderr).toContain('src/renderer/components/Existing.tsx:1:');
  });

  it('rejects a hand-raised baseline that hides a new literal, unless the entry carries a reason', () => {
    const baseEnv = { RENDERER_CJK_RATCHET_BASE_REF: 'HEAD' };
    const samplePath = join(rendererRoot, 'Existing.tsx');
    writeFileSync(samplePath, 'export const Existing = () => <div>正文一</div>;\n', 'utf8');
    writeFileSync(join(contractRoot, 'boundary.ts'), 'export const BOUNDARY = "既有边界文案";\n', 'utf8');
    writeBaseline({
      'src/renderer/components/Existing.tsx': 1,
      'src/shared/contract/boundary.ts': 1,
    });
    git('init', '-q');
    commitAll('base');

    const clean = runCli([], baseEnv);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).not.toContain('未做手工上调比对');

    // Add a literal AND bump the number by hand so current == baseline: still red
    writeFileSync(
      samplePath,
      'export const Existing = () => <div title="新增标题">正文一</div>;\n',
      'utf8',
    );
    writeBaseline({
      'src/renderer/components/Existing.tsx': 2,
      'src/shared/contract/boundary.ts': 1,
    });
    const raised = runCli([], baseEnv);
    expect(raised.status).toBe(1);
    expect(raised.stderr).toContain('基线被手工上调');
    expect(raised.stderr).toContain('src/renderer/components/Existing.tsx: 已提交基线=1 → 工作区基线=2');
    expect(runCli(['--update-baseline'], baseEnv).status).toBe(1);

    // A brand-new entry added by hand is the same violation
    writeFileSync(samplePath, 'export const Existing = () => <div>正文一</div>;\n', 'utf8');
    writeFileSync(join(rendererRoot, 'Added.tsx'), 'export const Added = () => <div>新增文件</div>;\n', 'utf8');
    writeBaseline({
      'src/renderer/components/Added.tsx': 1,
      'src/renderer/components/Existing.tsx': 1,
      'src/shared/contract/boundary.ts': 1,
    });
    const added = runCli([], baseEnv);
    expect(added.status).toBe(1);
    expect(added.stderr).toContain('src/renderer/components/Added.tsx: 已提交基线=0 → 工作区基线=1');

    // The documented exception path: an object entry with a reason is accepted and printed
    writeBaseline({
      'src/renderer/components/Added.tsx': { count: 1, reason: 'Existing.tsx 拆分出的存量' },
      'src/renderer/components/Existing.tsx': 1,
      'src/shared/contract/boundary.ts': 1,
    });
    const reasoned = runCli([], baseEnv);
    expect(reasoned.status, reasoned.stderr).toBe(0);
    expect(reasoned.stdout).toContain('例外上调');
    expect(reasoned.stdout).toContain('reason=Existing.tsx 拆分出的存量');

    // Inside a git repo an unresolvable comparison base fails loud instead of skipping the check
    const noBase = runCli([], { RENDERER_CJK_RATCHET_BASE_REF: 'refs/heads/no-such-branch' });
    expect(noBase.status).toBe(1);
    expect(noBase.stderr).toContain('无法解析比较基点');
  });

  it('supports baseline object entries with non-empty reason and rejects missing reason or escape comments', () => {
    writeFileSync(
      join(rendererRoot, 'CommentAttempt.tsx'),
      [
        '// cjk-allow: 试图用行内注释豁免',
        'export const CommentAttempt = () => <div>不被允许的行内豁免</div>;',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(join(contractRoot, 'ok.ts'), 'export const OK = "契约存量";\n', 'utf8');

    // Escape comments do NOT exempt an unbaselined file
    writeBaseline({
      'src/shared/contract/ok.ts': { count: 1, reason: '合法例外示例' },
    });
    const escapeAttempt = runCli();
    expect(escapeAttempt.status).toBe(1);
    expect(escapeAttempt.stderr).toContain('src/renderer/components/CommentAttempt.tsx:2:');

    // Empty reason on object entry fails loud
    writeBaseline({
      'src/renderer/components/CommentAttempt.tsx': { count: 1, reason: '   ' },
      'src/shared/contract/ok.ts': 1,
    });
    const emptyReason = runCli();
    expect(emptyReason.status).toBe(1);
    expect(emptyReason.stderr).toContain('必须提供非空 reason');
  });

  it('fails loud on 0 scanned files, 0 targets, or TypeScript parse errors', () => {
    writeBaseline({});
    // 0 files in rendererRoot / contractRoot
    expect(runCli().status).toBe(1);
    expect(runCli().stderr).toContain('扫描 0 个源文件');

    // Files present, 0 CJK targets
    writeFileSync(join(rendererRoot, 'Clean.tsx'), 'export const Clean = () => <div>Hello</div>;\n', 'utf8');
    writeFileSync(join(contractRoot, 'clean.ts'), 'export const CLEAN = "Hello";\n', 'utf8');
    const zeroTargets = runCli();
    expect(zeroTargets.status).toBe(1);
    expect(zeroTargets.stderr).toContain('命中 0 个 CJK 字面量');

    // TS parse error
    writeFileSync(join(rendererRoot, 'Broken.tsx'), 'export const Broken = () => <div>未闭合;\n', 'utf8');
    const parseErr = runCli();
    expect(parseErr.status).toBe(1);
    expect(parseErr.stderr).toContain('TypeScript 解析失败');
  });

  it('passes on the live repository baseline', () => {
    // HEAD 作比较基点：浅克隆的 CI job 里没有 origin/main，但 HEAD 一定在
    const live = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, RENDERER_CJK_RATCHET_BASE_REF: 'HEAD' },
    });
    expect(live.status, live.stderr).toBe(0);
    expect(live.stdout).toContain('[renderer-cjk-literal-ratchet] ✓');
  });
});
