// tsc-tests-ratchet 的 tsc 参数拼装（独立成文件便于单测）。
// 本机/工人机：开 typescript7 的 incremental，tsbuildinfo 放在 worktree 内 .cache/（已 gitignore，
//   每个 worktree 各一份，互不写穿）。CI（CI=true）与显式 TSC_TESTS_NO_INCREMENTAL=1：不增量，照全量冷跑。
// 失效由引擎保证：buildinfo 记 tsc 版本 + 配置 + 每个文件内容哈希，文件/依赖/配置/引擎变了都会重查；
//   buildinfo 损坏会被当作无缓存重建（见 tests/scripts/tscTestsIncremental.test.ts 实测）。
import path from 'node:path';

export const TESTS_BUILDINFO_REL = path.join('.cache', 'tsc-tests.tsbuildinfo');

export function isIncremental(env) {
  if (String(env.CI ?? '').toLowerCase() === 'true' || env.CI === '1') return false;
  return env.TSC_TESTS_NO_INCREMENTAL !== '1';
}

export function buildTscArgs({ tscBin, tsconfigPath, repoRoot, env }) {
  const args = [tscBin, '-p', tsconfigPath, '--noEmit', '--pretty', 'false'];
  if (isIncremental(env)) {
    args.push('--incremental', '--tsBuildInfoFile', path.join(repoRoot, TESTS_BUILDINFO_REL));
  }
  return args;
}
