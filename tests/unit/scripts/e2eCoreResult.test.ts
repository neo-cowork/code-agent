import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../../scripts/e2e-core/args';
import { CORE_FLOWS, CORE_FLOW_IDS } from '../../../scripts/e2e-core/flows';
import {
  buildAttempt, buildFlowResult, buildResult, exitCodeFor, formatFailure,
} from '../../../scripts/e2e-core/result';

const passed = (n: number) => buildAttempt({ n, failedStep: null, durationMs: 1000, screenshot: `/s/${n}.png`, sse: `/s/${n}.sse`, db: `/s/db-${n}.json`, reason: '' });
const failed = (n: number) => buildAttempt({
  n, failedStep: { n: 2, text: '审批卡出现，核对命令正文只出现一次。' }, durationMs: 2000,
  screenshot: '/s/f.png', sse: '/s/f.sse', db: '/s/db-f.json', reason: '命令正文出现了 2 次',
});
const meta = { startedAt: '2026-11-17T00:00:00.000Z', commit: 'abc1234', model: 'xiaomi/test' };

describe('e2e-core result.json', () => {
  it('a failed attempt keeps which step broke, and a passing one has none', () => {
    expect(failed(1)).toMatchObject({ status: 'fail', failedStep: { n: 2, text: '审批卡出现，核对命令正文只出现一次。' }, reason: '命令正文出现了 2 次' });
    expect(passed(1)).toMatchObject({ status: 'pass', failedStep: null });
  });

  it('shapes the documented schema and counts stable flows', () => {
    const result = buildResult(meta, [
      buildFlowResult('F05', '审批卡：允许一次', [passed(1), passed(2), passed(3)]),
      buildFlowResult('F06', '审批卡：拒绝', [passed(1), failed(2), passed(3)]),
    ]);
    expect(Object.keys(result)).toEqual(['schema', 'startedAt', 'commit', 'model', 'flows', 'summary']);
    expect(result.schema).toBe(1);
    expect(result.summary).toEqual({ pass: 5, fail: 1, skip: 0, stable3: 1 });
    expect(result.flows.map((f) => [f.id, f.stable])).toEqual([['F05', true], ['F06', false]]);
    expect(Object.keys(result.flows[1].attempts[1])).toEqual(['n', 'status', 'failedStep', 'durationMs', 'screenshot', 'sse', 'db', 'reason']);
    expect(exitCodeFor(result)).toBe(1);
  });

  it('exit code is 0 only when every attempt passed', () => {
    expect(exitCodeFor(buildResult(meta, [buildFlowResult('F05', 't', [passed(1)])]))).toBe(0);
    expect(exitCodeFor(buildResult(meta, []))).toBe(1);
  });

  it('prints FAIL <id> step <n>: <sentence> with screenshot, sse and db paths', () => {
    expect(formatFailure('F05', failed(1))).toBe([
      'FAIL F05 step 2: 审批卡出现，核对命令正文只出现一次。',
      '  attempt: 1  reason: 命令正文出现了 2 次',
      '  screenshot: /s/f.png',
      '  sse: /s/f.sse',
      '  db: /s/db-f.json',
    ].join('\n'));
  });
});

describe('e2e-core runner config', () => {
  it('runs exactly the five chosen flows, every map step sentence comes from the feature-map card', () => {
    expect(CORE_FLOW_IDS).toEqual(['F05', 'F06', 'F08', 'F10', 'F14']);
    expect(CORE_FLOWS.map((f) => f.id)).toEqual(CORE_FLOW_IDS);
    const map = fs.readFileSync(path.resolve(__dirname, '../../../docs/e2e/feature-map.md'), 'utf8');
    for (const flow of CORE_FLOWS) {
      const card = map.slice(map.indexOf(`### ${flow.id} —`), map.indexOf('### F', map.indexOf(`### ${flow.id} —`) + 5));
      for (const step of flow.steps.filter((s) => !s.text.startsWith('核对可观测量'))) {
        const sentence = step.text.replace(/。$/, '');
        expect(card, `${flow.id}: ${step.text}`).toContain(sentence);
      }
    }
  });

  it('parses defaults and overrides', () => {
    const base = parseArgs([], {}, '/repo');
    expect(base).toMatchObject({ repeat: 3, out: '/repo/test-results/e2e-core', reuseBuild: false, only: null });
    const custom = parseArgs(['--repeat', '2', '--out', 'x', '--reuse-build', '--only', 'f05,F06'], { NEO_REALRUN_BIN: '/bin/rr.mjs' }, '/repo');
    expect(custom).toMatchObject({ repeat: 2, out: '/repo/x', reuseBuild: true, only: ['F05', 'F06'], realrunBin: '/bin/rr.mjs' });
    expect(() => parseArgs(['--repeat', '0'], {}, '/repo')).toThrow();
    expect(() => parseArgs(['--nope'], {}, '/repo')).toThrow();
  });
});
