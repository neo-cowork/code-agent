import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../../scripts/e2e-core/args';
import { CORE_FLOWS, CORE_FLOW_IDS, NOT_SCRIPTTABLE_FLOWS, SHELL_WEB_FLOWS } from '../../../scripts/e2e-core/flows';
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

  it('an infrastructure interruption is a skip, not a flow failure, and still blocks exit 0', () => {
    const skipped = buildAttempt({ n: 1, infra: true, failedStep: { n: 3, text: 's' }, durationMs: 1, screenshot: null, sse: null, db: null, reason: 'browser has been closed' });
    expect(skipped.status).toBe('skip');
    expect(formatFailure('F08', skipped)).toMatch(/^SKIP F08 step 3: s/);
    const result = buildResult(meta, [buildFlowResult('F08', 't', [skipped, passed(2), passed(3)])]);
    expect(result.summary).toEqual({ pass: 2, fail: 0, skip: 1, stable3: 0 });
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
  it('runs exactly the ten chosen web flows, every map step sentence comes from the feature-map card', () => {
    expect(CORE_FLOW_IDS).toEqual(['F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F14', 'F15', 'F16', 'F17']);
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

  it('every flow id in the map index is either scripted, shell-only, or explicitly not scriptable', () => {
    const map = fs.readFileSync(path.resolve(__dirname, '../../../docs/e2e/feature-map.md'), 'utf8');
    const index = map.slice(map.indexOf('## 索引'), map.indexOf('## 流程卡'));
    const ids = [...index.matchAll(/^\| (F\d\d) \|/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(15);
    const shellIds = SHELL_WEB_FLOWS.map((f) => f.id);
    const notScriptableIds = NOT_SCRIPTTABLE_FLOWS.map((f) => f.id);
    // 地图里每条流程必须有归属：本 runner 真跑 / shell 归真机批 / 显式不可脚本化，不许悄悄漏掉
    for (const id of ids) {
      expect(
        CORE_FLOW_IDS.includes(id) || shellIds.includes(id) || notScriptableIds.includes(id),
        `${id} must be in CORE_FLOW_IDS, SHELL_WEB_FLOWS or NOT_SCRIPTTABLE_FLOWS`,
      ).toBe(true);
    }
    const all = [...CORE_FLOW_IDS, ...shellIds, ...notScriptableIds];
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(ids, `${id} not in map index`).toContain(id);
  });

  it('lists the seven shell flows each with a one-line reason, and only F18 as not scriptable', () => {
    expect(SHELL_WEB_FLOWS.map((f) => f.id)).toEqual(['F01', 'F02', 'F03', 'F04', 'F11', 'F12', 'F13']);
    for (const flow of SHELL_WEB_FLOWS) {
      expect(flow.reason.trim().length, `${flow.id} needs a non-empty reason`).toBeGreaterThan(4);
    }
    expect(NOT_SCRIPTTABLE_FLOWS.map((f) => f.id)).toEqual(['F18']);
    expect(NOT_SCRIPTTABLE_FLOWS[0].reason.trim().length).toBeGreaterThan(4);
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
