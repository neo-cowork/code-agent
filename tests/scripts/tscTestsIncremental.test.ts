import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildTscArgs, isIncremental, TESTS_BUILDINFO_REL } from '../../scripts/lib/tsc-tests-args.mjs';

const root = path.resolve(__dirname, '../..');
const tscBin = path.join(root, 'node_modules', 'typescript7', 'bin', 'tsc');

describe('tsc-tests-ratchet 增量参数', () => {
  const base = { tscBin: 'tsc', tsconfigPath: '/r/tsconfig.tests.json', repoRoot: '/r' };
  it('本机默认增量，buildinfo 在 worktree 内 .cache/', () => {
    const a = buildTscArgs({ ...base, env: {} });
    expect(a).toContain('--incremental');
    expect(a[a.indexOf('--tsBuildInfoFile') + 1]).toBe(path.join('/r', TESTS_BUILDINFO_REL));
  });
  it('CI=true 与 TSC_TESTS_NO_INCREMENTAL=1 不增量（CI 照全量冷跑）', () => {
    expect(isIncremental({ CI: 'true' })).toBe(false);
    expect(isIncremental({ CI: 'TRUE' })).toBe(false);
    expect(isIncremental({ TSC_TESTS_NO_INCREMENTAL: '1' })).toBe(false);
    expect(buildTscArgs({ ...base, env: { CI: 'true' } })).not.toContain('--incremental');
  });
});

describe('增量缓存正确性（真跑 typescript7，小夹具）', () => {
  it('改依赖文件引入类型错 → 增量必须抓到；改回 → 变绿；缓存损坏 → 自动重建不假绿', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-incr-'));
    try {
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022' }, include: ['*.ts'] }));
      const a = path.join(dir, 'a.ts');
      fs.writeFileSync(a, 'export const foo = 1;\n');
      fs.writeFileSync(path.join(dir, 'b.ts'), "import { foo } from './a';\nexport const n: number = foo;\n");
      const info = path.join(dir, '.cache', 'x.tsbuildinfo');
      const run = () => {
        const args = buildTscArgs({ tscBin, tsconfigPath: path.join(dir, 'tsconfig.json'), repoRoot: dir, env: {} });
        args[args.indexOf('--tsBuildInfoFile') + 1] = info;
        const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
        return `${r.stdout}${r.stderr}`.split('\n').filter((l) => /: error TS/.test(l));
      };
      expect(run()).toHaveLength(0);
      expect(fs.existsSync(info)).toBe(true);
      expect(run()).toHaveLength(0); // 热跑
      fs.writeFileSync(a, 'export const foo = "s";\n'); // 改被依赖文件：b.ts 本身没动
      const bad = run();
      expect(bad).toHaveLength(1);
      expect(bad[0]).toContain('b.ts');
      expect(run()).toHaveLength(1); // 缓存回放同一条错，不因热而丢
      fs.writeFileSync(a, 'export const foo = 1;\n');
      expect(run()).toHaveLength(0);
      fs.writeFileSync(a, 'export const foo = "s";\n');
      fs.writeFileSync(info, 'garbage');
      expect(run()).toHaveLength(1); // 缓存损坏不假绿
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
