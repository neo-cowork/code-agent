import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import policy from '../../scripts/lib/gates-fast-policy.json';

const root = path.resolve(__dirname, '../..');

// Run the unchanged production runner in a committed fixture repository. The
// other gates are tiny passing commands; Git, selection, receipts and Vitest
// (including its manifest/config/report checks) execute for real.
function runFixture(count: number, failing = false, dirOf: (index: number) => string = () => 'tests/unit', opts: { ratchet?: string; ttBudgetMs?: number; env?: Record<string, string> } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fast-runner-contract-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (name: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  };
  try {
    for (const name of [
      'scripts/gates-fast.mjs', 'scripts/lib/gates-fast-contract.mjs',
      'scripts/lib/casebank-private-cache.mjs', 'scripts/lib/tmp-sandbox.mjs',
      'src/host/testing/answerSide.ts', 'vitest.fast.config.ts',
    ]) write(name, fs.readFileSync(path.join(root, name), 'utf8'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    write('.gitignore', 'node_modules/\n.reports/\n');
    const manifest = { type: 'module', scripts: { typecheck: 'node -e "process.exit(0)"' } };
    write('package.json', JSON.stringify(manifest));
    write('packages/fixture/package.json', JSON.stringify(manifest));
    write('package-lock.json', JSON.stringify({ packages: {} }));
    write('private/input.json', '{}');
    write('vitest.config.ts', "export default { test: { environment: 'node' } };\n");
    for (const name of ['check-provider-symmetry.sh', 'check-prompt-version-bump.sh', 'check-hardcoded-models.sh']) {
      write(`scripts/${name}`, 'exit 0\n');
    }
    for (const name of ['shell-fail-loud-lint.mjs', 'tsc-tests-ratchet.mjs', 'ci/check-casebank-answers.mjs', 'ci/shared-host-boundary.mjs', 'ci/user-visible-leak.mjs', 'ci/check-no-direct-app-exec.mjs']) {
      write(`scripts/${name}`, name === 'tsc-tests-ratchet.mjs' && opts.ratchet ? opts.ratchet : 'process.exit(0);\n');
    }
    // commit-checks runs ESLint too, using a fixture config without repo rules.
    write('eslint.config.js', 'export default [{ files: ["tests/**/*.ts"] }];\n');
    const files = Array.from({ length: count }, (_, index) => `${dirOf(index)}/selected${String(index).padStart(3, '0')}.test.ts`);
    for (const file of files) write(file, "import { test, expect } from 'vitest'; test('selected test', () => expect(1).toBe(1));\n");
    write('scripts/lib/gates-fast-policy.json', JSON.stringify({
      ...policy, budgetsMs: { ...policy.budgetsMs, ...(opts.ttBudgetMs ? { 'tests-typecheck': opts.ttBudgetMs } : {}) }, baseline: files, rules: [], packages: ['packages/fixture'],
      sharedPackageInputs: ['tests/**'], testsTypecheckInputs: ['tests/**'],
    }));
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.hooksPath', '/dev/null'); git('remote', 'add', 'origin', 'https://example.invalid/fixture.git');
    git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    write(files[0], `import { test, expect } from 'vitest'; test('selected test', () => expect(1).toBe(${failing ? 2 : 1}));\n// changed\n`);
    git('add', '.'); git('commit', '-qm', 'selected change');
    const result = spawnSync(process.execPath, ['scripts/gates-fast.mjs', '--base', base, '--receipt', '.reports/gates-fast/result.json'], {
      cwd: dir, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, NEO_EVAL_ANSWERS_DIR: path.join(dir, 'private'), GATES_FAST_CACHE_DIR: path.join(dir, '.reports/cache'), GATES_FAST_BUDGET_SCALE: '1', SHIP_FASTGATE_TIMEOUT_S: '180', CI: '', ...opts.env },
    });
    expect(result.error).toBeUndefined();
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, '.reports/gates-fast/result.json'), 'utf8'));
    expect(receipt.headSha).toBe(git('rev-parse', 'HEAD'));
    expect(receipt.treeSha).toBe(git('rev-parse', 'HEAD^{tree}'));
    expect(git('status', '--porcelain')).toBe('');
    return { result, receipt, files };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('fast gate runner deferral', () => {
  it('17 files: inputs passes, only vitest defers, full receipt persists and exit is zero', () => {
    const { result, receipt, files } = runFixture(17);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(receipt.status).toBe('passed');
    expect(receipt.selectedFiles).toEqual(files);
    expect(receipt.vitestDeferred).toEqual({ reason: 'over-cap', selected: 17, maxFiles: 16, files, localFiles: [] });
    expect(receipt.gates).toHaveLength(Object.keys(policy.budgetsMs).length);
    for (const gate of receipt.gates) expect(gate.status, gate.id).toBe(gate.id === 'vitest' ? 'deferred-to-ci' : 'passed');
    expect(receipt.gates.find((gate: { id: string }) => gate.id === 'vitest').durationMs).toBe(0);
    expect(receipt.commands.some((command: { argv: string[] }) => command.argv.includes('node_modules/vitest/vitest.mjs'))).toBe(false);
    expect(receipt.report).toBeNull();
    expect(result.stdout).toContain('gates:fast vitest deferred to PR CI: selected 17 files > 16');
    expect(receipt.ci.status).toBe('pending');
  }, 30000);

  const hang = "setTimeout(() => {}, 60000);\n";
  const over = "console.error('[tsc-tests-ratchet] ✗ 超基线 3 处'); process.exit(1);\n";
  it('tests-typecheck over local budget with no error count: deferred-to-ci, exit zero, receipt says so', () => {
    const { result, receipt } = runFixture(1, false, () => 'tests/unit', { ratchet: hang, ttBudgetMs: 1500 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(receipt.status).toBe('passed');
    expect(receipt.gates.find((gate: { id: string }) => gate.id === 'tests-typecheck')).toMatchObject({ status: 'deferred-to-ci' });
    expect(receipt.testsTypecheckDeferred).toMatchObject({ reason: 'local-over-budget', budgetMs: 1500 });
    expect(result.stdout).toContain('交 PR CI');
  }, 30000);

  it('tests-typecheck with new errors over baseline: failed, not deferred', () => {
    const { result, receipt } = runFixture(1, false, () => 'tests/unit', { ratchet: over, ttBudgetMs: 1500 });
    expect(result.status).toBe(1);
    expect(receipt.gates.find((gate: { id: string }) => gate.id === 'tests-typecheck').status).toBe('failed');
    expect(receipt.testsTypecheckDeferred).toBeUndefined();
  }, 30000);

  it('tests-typecheck over budget under CI=true: failed, deferral not allowed', () => {
    const { result, receipt } = runFixture(1, false, () => 'tests/unit', { ratchet: hang, ttBudgetMs: 1500, env: { CI: 'true' } });
    expect(result.status).toBe(1);
    expect(receipt.error).toContain('gate budget 1500ms exceeded');
    expect(receipt.gates.find((gate: { id: string }) => gate.id === 'tests-typecheck').status).toBe('failed');
  }, 30000);

  it('18 mixed files: only the 3 tests/wrappers files run locally, the 15 CI-covered ones defer', () => {
    const { result, receipt, files } = runFixture(18, false, (index) => (index < 3 ? 'tests/wrappers' : 'tests/unit'));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(receipt.vitestDeferred).toEqual({ reason: 'over-cap', selected: 18, maxFiles: 16, files: files.slice(3), localFiles: files.slice(0, 3) });
    expect(receipt.vitestDeferred.files.length + receipt.vitestDeferred.localFiles.length).toBe(receipt.vitestDeferred.selected);
    expect(receipt.gates.find((gate: { id: string }) => gate.id === 'vitest').status).toBe('passed');
    expect(receipt.report).toMatchObject({ files: 3, tests: 3, passed: 3 });
    expect(result.stdout).toContain('gates:fast vitest deferred to PR CI: selected 18 files > 16');
  }, 30000);

  it('17 files that PR CI does not run (tests/wrappers): rejected, never deferred', () => {
    const { result, receipt } = runFixture(17, false, () => 'tests/wrappers');
    expect(result.status).toBe(1);
    expect(receipt.error).toContain('FAIL: selected 17 files; allowed 1..16/200');
    expect(receipt.gates[0]).toMatchObject({ id: 'inputs', status: 'failed' });
    expect(receipt.vitestDeferred).toBeUndefined();
    expect(receipt.commands).toEqual([]);
  }, 30000);

  it('16 files: executes the exact full selection through real Vitest', () => {
    const { result, receipt, files } = runFixture(16);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(receipt.vitestDeferred).toBeUndefined();
    expect(receipt.selectedFiles).toEqual(files);
    expect(receipt.gates.find((gate: { id: string }) => gate.id === 'vitest').status).toBe('passed');
    expect(receipt.report).toMatchObject({ files: 16, tests: 16, passed: 16 });
    expect(result.stdout).not.toContain('vitest deferred');
  }, 30000);

  it('201 files: inputs fails with the existing hard-limit message', () => {
    const { result, receipt } = runFixture(201);
    expect(result.status).toBe(1);
    expect(receipt.error).toBe('FAIL: selected 201 files; allowed 1..200; never truncate');
    expect(receipt.gates[0]).toMatchObject({ id: 'inputs', status: 'failed' });
    expect(receipt.vitestDeferred).toBeUndefined();
    expect(receipt.commands).toEqual([]);
  }, 30000);

  it('a real failing test in a 16-file selection still fails vitest and the process', () => {
    const { result, receipt } = runFixture(16, true);
    expect(result.status).toBe(1);
    expect(receipt.status).toBe('failed');
    expect(receipt.vitestDeferred).toBeUndefined();
    expect(receipt.gates.find((gate: { id: string }) => gate.id === 'vitest').status).toBe('failed');
    expect(receipt.error).toContain('FAIL: exit 1');
    expect(receipt.error).toContain('selected000.test.ts::selected test: AssertionError: expected 1 to be 2');
  }, 30000);
});
