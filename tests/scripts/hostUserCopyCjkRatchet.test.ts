import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scriptPath = resolve('scripts/host-user-copy-cjk-ratchet.mjs');

describe('host-user-copy-cjk-ratchet', () => {
  let repoRoot: string;
  let hostRoot: string;
  let baselinePath: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'host-user-copy-cjk-ratchet-'));
    hostRoot = join(repoRoot, 'src/host/services');
    baselinePath = join(repoRoot, 'scripts/host-user-copy-cjk-baseline.json');
    mkdirSync(hostRoot, { recursive: true });
    mkdirSync(join(repoRoot, 'src/host/prompts'), { recursive: true });
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function runCli(extraArgs: string[] = []) {
    return spawnSync(process.execPath, [scriptPath, '--repo-root', repoRoot, ...extraArgs], {
      encoding: 'utf8',
      env: { ...process.env, HOST_USER_COPY_RATCHET_BASE_REF: 'HEAD' },
    });
  }

  function writeBaseline(files: Record<string, number | { count: number; reason?: string }>) {
    writeFileSync(baselinePath, JSON.stringify({ schemaVersion: 1, files }, null, 2), 'utf8');
  }

  const SAMPLE = [
    "export const a = { message: '失败了', other: '中文但不是用户属性', title: `标题 ${1}` };",
    "export function f() { throw new Error('出错了'); }",
    "export function g() { return { error: ('括号' as string), summary: 'English only', text: x ? '三元' : '分支' }; }",
    "// message: '注释里的中文'",
    '',
  ].join('\n');

  it('counts only user-copy properties and throw new *Error args; ignores prompts, tests, comments', () => {
    writeFileSync(join(hostRoot, 'sample.ts'), SAMPLE);
    writeFileSync(join(hostRoot, 'sample.test.ts'), "export const t = { message: '测试' };\n");
    writeFileSync(join(repoRoot, 'src/host/prompts/p.ts'), "export const p = { text: '提示词' };\n");
    writeFileSync(join(repoRoot, 'src/host/prompts/q.ts'), "export const q = { description: '提示词' };\n");
    const init = runCli(['--init-baseline']);
    expect(init.status, init.stderr).toBe(0);
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    // message + title + throw + error(括号剥掉) = 4；三元分支不计
    expect(baseline.files).toEqual({ 'src/host/services/sample.ts': 4 });
  });

  it('fails when a new Chinese message literal is added, passes after removal', () => {
    writeFileSync(join(hostRoot, 'sample.ts'), SAMPLE);
    writeBaseline({ 'src/host/services/sample.ts': 4 });
    expect(runCli().status).toBe(0);

    writeFileSync(join(hostRoot, 'sample.ts'), `${SAMPLE}export const n = { message: '新增中文' };\n`);
    const red = runCli();
    expect(red.status).toBe(1);
    expect(red.stderr).toContain('current=5 > baseline=4');

    writeFileSync(join(hostRoot, 'sample.ts'), SAMPLE);
    expect(runCli().status).toBe(0);
  });

  it('fails on a new file outside the baseline and on a stale (too-high) baseline', () => {
    writeFileSync(join(hostRoot, 'sample.ts'), SAMPLE);
    writeBaseline({ 'src/host/services/sample.ts': 5 });
    const stale = runCli();
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('基线过期');

    writeBaseline({ 'src/host/services/sample.ts': 4 });
    writeFileSync(join(hostRoot, 'other.ts'), "export const o = { label: '新文件' };\n");
    const fresh = runCli();
    expect(fresh.status).toBe(1);
    expect(fresh.stderr).toContain('src/host/services/other.ts');
  });

  it('rejects an object baseline entry without a reason and unknown args', () => {
    writeFileSync(join(hostRoot, 'sample.ts'), SAMPLE);
    writeBaseline({ 'src/host/services/sample.ts': { count: 4, reason: '' } });
    expect(runCli().status).toBe(1);
    expect(runCli(['--nope']).status).toBe(1);
  });

  it('fails loud when nothing matches', () => {
    writeFileSync(join(hostRoot, 'sample.ts'), "export const x = { message: 'english' };\n");
    writeBaseline({});
    const res = runCli();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('命中 0');
  });
});
