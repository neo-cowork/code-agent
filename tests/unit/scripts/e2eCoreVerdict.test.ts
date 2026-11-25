import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAttempt,
  buildFlowResult,
  buildResult,
  type CoreResult,
} from '../../../scripts/e2e-core/result';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const VERDICT_SCRIPT = path.join(REPO_ROOT, 'scripts/e2e-core/verdict.ts');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules/.bin/tsx');

const meta = {
  startedAt: '2026-11-25T00:00:00.000Z',
  commit: 'abc1234',
  model: 'xiaomi/test',
};

const passed = (n: number) =>
  buildAttempt({
    n,
    failedStep: null,
    durationMs: 1000,
    screenshot: `/s/${n}.png`,
    sse: `/s/${n}.sse`,
    db: `/s/db-${n}.json`,
    reason: '',
  });

const failed = (n: number, stepNum = 2, text = '审批卡出现，核对命令正文只出现一次。') =>
  buildAttempt({
    n,
    failedStep: { n: stepNum, text },
    durationMs: 2000,
    screenshot: `/s/f-${n}.png`,
    sse: `/s/f-${n}.sse`,
    db: `/s/db-f-${n}.json`,
    reason: '命令正文出现了 2 次',
  });

const skipped = (n: number, stepNum = 1, text = '打开工作台并等待就绪') =>
  buildAttempt({
    n,
    infra: true,
    failedStep: { n: stepNum, text },
    durationMs: 100,
    screenshot: null,
    sse: null,
    db: null,
    reason: 'browser has been closed',
  });

interface RunOutput {
  code: number;
  stdout: string;
  stderr: string;
}

function runVerdict(args: string[]): RunOutput {
  try {
    const stdout = execFileSync(TSX_BIN, [VERDICT_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? -1,
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? '').trim(),
    };
  }
}

let tmpDir = '';

function writeFixture(name: string, result: CoreResult): string {
  const filePath = path.join(tmpDir, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf8');
  return filePath;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-core-verdict-'));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('e2e-core verdict CLI', () => {
  it('returns 0 GREEN when all attempts pass and notes under-repeated flows', () => {
    const fullFile = writeFixture(
      'green-full',
      buildResult(meta, [
        buildFlowResult('F05', '审批卡：允许一次', [passed(1), passed(2), passed(3)]),
        buildFlowResult('F06', '审批卡：拒绝', [passed(1), passed(2), passed(3)]),
      ]),
    );
    const full = runVerdict(['--result', fullFile]);
    expect(full.code).toBe(0);
    expect(full.stdout.split('\n')).toHaveLength(1);
    expect(full.stdout).toContain('GREEN');
    expect(full.stdout).toContain('abc1234');
    expect(full.stdout).not.toContain('ran only');

    const shortFile = writeFixture(
      'green-short',
      buildResult(meta, [buildFlowResult('F05', '审批卡：允许一次', [passed(1), passed(2)])]),
    );
    const short = runVerdict(['--result', shortFile]);
    expect(short.code).toBe(0);
    expect(short.stdout).toContain('F05 ran only 2 of 3 repeats');
  });

  it('returns 2 RED when a flow fails every attempt, naming flow id and step number', () => {
    const file = writeFixture(
      'red',
      buildResult(meta, [
        buildFlowResult('F05', '审批卡：允许一次', [passed(1), passed(2), passed(3)]),
        buildFlowResult('F06', '审批卡：拒绝', [failed(1, 2), failed(2, 2), failed(3, 2)]),
        buildFlowResult('F07', '长会话', [failed(1, 4, '滚动到底部')]),
      ]),
    );
    const out = runVerdict(['--result', file]);
    expect(out.code).toBe(2);
    expect(out.stdout.split('\n')).toHaveLength(1);
    expect(out.stdout).toBe('FAIL F06 step 2: 审批卡出现，核对命令正文只出现一次。 (+1 more)');
  });

  it('returns 3 FLAKY when a flow has both pass and fail attempts', () => {
    const file = writeFixture(
      'flaky',
      buildResult(meta, [
        buildFlowResult('F05', '审批卡：允许一次', [passed(1), failed(2, 3, '点击允许一次'), passed(3)]),
      ]),
    );
    const out = runVerdict(['--result', file]);
    expect(out.code).toBe(3);
    expect(out.stdout.split('\n')).toHaveLength(1);
    expect(out.stdout).toContain('FLAKY F05');
    expect(out.stdout).toContain('2/3');
    expect(out.stdout).toContain('step 3: 点击允许一次');
  });

  it('returns 5 SKIP when any attempt is skipped due to infra, stating environment not set up', () => {
    const file = writeFixture(
      'skip',
      buildResult(meta, [
        buildFlowResult('F08', '附件上传', [skipped(1, 1, '打开工作台并等待就绪'), passed(2), passed(3)]),
      ]),
    );
    const out = runVerdict(['--result', file]);
    expect(out.code).toBe(5);
    expect(out.stdout.split('\n')).toHaveLength(1);
    expect(out.stdout).toMatch(/^SKIP F08 step 1: 打开工作台并等待就绪/);
    expect(out.stdout).toContain('environment not set up');
  });

  it('returns 4 MISMATCH when --commit does not match, and accepts prefix-compatible shas', () => {
    const file = writeFixture(
      'commit',
      buildResult(meta, [buildFlowResult('F05', '审批卡：允许一次', [passed(1), passed(2), passed(3)])]),
    );

    const mismatch = runVerdict(['--result', file, '--commit', 'def5678901234']);
    expect(mismatch.code).toBe(4);
    expect(mismatch.stdout.split('\n')).toHaveLength(1);
    expect(mismatch.stdout).toContain('abc1234');
    expect(mismatch.stdout).toContain('def5678901234');

    const fullShaMatch = runVerdict(['--result', file, '--commit', 'abc1234567890abcdef']);
    expect(fullShaMatch.code).toBe(0);
    expect(fullShaMatch.stdout).toContain('GREEN');
  });

  it('returns 6 NO-RESULT for missing file or zero flows', () => {
    const missing = runVerdict(['--result', path.join(tmpDir, 'does-not-exist.json')]);
    expect(missing.code).toBe(6);
    expect(missing.stdout.split('\n')).toHaveLength(1);
    expect(missing.stdout).toContain('NO-RESULT');

    const emptyFile = writeFixture('empty', buildResult(meta, []));
    const empty = runVerdict(['--result', emptyFile]);
    expect(empty.code).toBe(6);
    expect(empty.stdout).toContain('NO-RESULT');
  });

  it('gives RED precedence over SKIP when both appear in the same result', () => {
    const file = writeFixture(
      'red-beats-skip',
      buildResult(meta, [
        buildFlowResult('F08', '附件上传', [skipped(1, 1, '打开工作台并等待就绪')]),
        buildFlowResult('F06', '审批卡：拒绝', [failed(1, 2), failed(2, 2)]),
      ]),
    );
    const out = runVerdict(['--result', file]);
    expect(out.code).toBe(2);
    expect(out.stdout).toMatch(/^FAIL F06 step 2:/);
  });

  it('returns 64 with usage on stderr for bad CLI arguments', () => {
    const out = runVerdict(['--unknown-flag']);
    expect(out.code).toBe(64);
    expect(out.stderr).toContain('Usage:');
  });
});
