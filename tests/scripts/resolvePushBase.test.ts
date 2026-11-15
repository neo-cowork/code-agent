import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/ci/resolve-push-base.mjs');
const roots: string[] = [];

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeOrigin() {
  // 4 个提交的 origin；shas[3] 是 HEAD，shas[0] 是 HEAD~3。
  const origin = mkdtempSync(join(tmpdir(), 'resolve-push-base-origin-'));
  roots.push(origin);
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'user.email', 'fixture@example.com']);
  git(origin, ['config', 'user.name', 'Fixture']);
  // 按 SHA fetch 需要服务端放行（GitHub 对可达对象放行；部分 git 构建的本地
  // file:// upload-pack 默认拒绝）。本机 Apple Git 2.54 实测不放行也能取到，
  // 设上是让夹具在别的 git 版本上同样成立。
  git(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const shas: string[] = [];
  for (let index = 1; index <= 4; index += 1) {
    writeFileSync(join(origin, `commit-${index}.txt`), `commit ${index}\n`);
    git(origin, ['add', '.']);
    git(origin, ['commit', '-qm', `commit ${index}`]);
    shas.push(git(origin, ['rev-parse', 'HEAD']));
  }
  return { origin, shas };
}

function shallowClone(origin: string) {
  // 复刻 main-full-gate 的检出形态：深度 2 + 走 upload-pack 传输（--no-local）。
  const clone = mkdtempSync(join(tmpdir(), 'resolve-push-base-clone-'));
  roots.push(clone);
  execFileSync('git', ['clone', '-q', '--depth', '2', '--no-local', `file://${origin}`, clone]);
  return clone;
}

function run(clone: string, arg: string) {
  return spawnSync(process.execPath, [script, arg], { cwd: clone, encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolve-push-base', () => {
  it('before 落在浅历史之外时按需补取该提交，stdout 原样返回 sha', () => {
    const { origin, shas } = makeOrigin();
    const clone = shallowClone(origin);
    const before = shas[0]; // HEAD~3：一次 push 带多个提交时的 before 位置
    // 前提成立：深度 2 克隆里确实没有这个对象（正是 run 43212993532 的红因）
    expect(spawnSync('git', ['cat-file', '-e', `${before}^{commit}`], { cwd: clone }).status).not.toBe(0);

    const result = run(clone, before);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(before);
    expect(result.stderr).toBe('');
    // 对象真的进了浅克隆：棘轮随后的 git show <sha>:<baseline.json> 依赖这一点
    expect(git(clone, ['show', `${before}:commit-1.txt`])).toContain('commit 1');
  });

  it('before 已在浅历史内（HEAD^）时原样返回，不发起 fetch', () => {
    const { origin, shas } = makeOrigin();
    const clone = shallowClone(origin);
    // 拿掉 origin：此用例若发生任何 fetch 都会失败并降级 HEAD^，下面的断言即红
    git(clone, ['remote', 'remove', 'origin']);
    const result = run(clone, shas[2]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(shas[2]);
    expect(result.stderr).toBe('');
  });

  it('不可达 sha：降级 HEAD^，stderr 留下 ::warning:: 与真实 git 报错', () => {
    const { origin } = makeOrigin();
    const clone = shallowClone(origin);
    const ghost = 'deadbeef'.repeat(5); // 40-hex，origin 对象库里不存在
    const result = run(clone, ghost);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('HEAD^');
    expect(result.stderr).toContain('::warning::');
    expect(result.stderr).toContain('HEAD^');
    expect(result.stderr).toContain(ghost);
    expect(result.stderr).toMatch(/fatal:|remote error/); // git 自己的报错文本，不许吞
  });

  it('空与全零 before（workflow_dispatch / 初始推送）直接用 HEAD^，且不打警告', () => {
    const { origin, shas } = makeOrigin();
    const clone = shallowClone(origin);
    git(clone, ['remote', 'remove', 'origin']);
    for (const arg of ['', '0'.repeat(40)]) {
      const result = run(clone, arg);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('HEAD^');
      expect(result.stderr).toBe('');
    }
    expect(git(clone, ['rev-parse', 'HEAD^'])).toBe(shas[2]);
  });
});
