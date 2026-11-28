import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../../scripts/e2e-core/args';
import { SLOT_FLOWS } from '../../../scripts/e2e-core/calendarFlows';
import { CORE_FLOWS, CORE_FLOW_IDS, SHELL_WEB_FLOWS } from '../../../scripts/e2e-core/flows';
import type { AttemptEnv, DbSnapshot } from '../../../scripts/e2e-core/types';
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
  it('runs exactly the eleven chosen web flows, every map step sentence comes from the feature-map card', () => {
    expect(CORE_FLOW_IDS).toEqual(['F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F14', 'F15', 'F16', 'F17', 'F18']);
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

  it('every flow id in the map index is either scripted or shell-only, and the lists do not overlap', () => {
    const map = fs.readFileSync(path.resolve(__dirname, '../../../docs/e2e/feature-map.md'), 'utf8');
    const index = map.slice(map.indexOf('## 索引'), map.indexOf('## 流程卡'));
    const ids = [...index.matchAll(/^\| (F\d\d) \|/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(15);
    const shellIds = SHELL_WEB_FLOWS.map((f) => f.id);
    // 地图里每条流程必须有归属：要么本 runner 真跑，要么 shell 归真机批——不许悄悄漏掉
    for (const id of ids) {
      expect(CORE_FLOW_IDS.includes(id) || shellIds.includes(id), `${id} must be in CORE_FLOW_IDS or SHELL_WEB_FLOWS`).toBe(true);
    }
    const all = [...CORE_FLOW_IDS, ...shellIds];
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(ids, `${id} not in map index`).toContain(id);
  });

  it('lists the seven shell flows each with a one-line reason', () => {
    expect(SHELL_WEB_FLOWS.map((f) => f.id)).toEqual(['F01', 'F02', 'F03', 'F04', 'F11', 'F12', 'F13']);
    for (const flow of SHELL_WEB_FLOWS) {
      expect(flow.reason.trim().length, `${flow.id} needs a non-empty reason`).toBeGreaterThan(4);
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

describe('e2e-core slot attach (calendar flows)', () => {
  const slotFlow = (id: string) => SLOT_FLOWS.find((f) => f.id === id) ?? (() => { throw new Error(`no slot flow ${id}`); })();

  it('parses --slot and refuses the reserved slots 1 and 4 with a clear non-zero-exit message', () => {
    expect(parseArgs(['--slot', '2'], {}, '/repo').slot).toBe(2);
    expect(parseArgs(['--slot', '9'], {}, '/repo').slot).toBe(9);
    expect(() => parseArgs(['--slot', '1'], {}, '/repo')).toThrow('槽 1 留给真机批');
    expect(() => parseArgs(['--slot', '4'], {}, '/repo')).toThrow('槽 4 保留');
    expect(() => parseArgs(['--slot', '0'], {}, '/repo')).toThrow('1-9');
    expect(() => parseArgs(['--slot', 'x'], {}, '/repo')).toThrow();
    expect(() => parseArgs(['--slot'], {}, '/repo')).toThrow('缺少取值');
  });

  it('slot calendar flows F01-F04 keep the feature-map card sentences, carry the step-0 probe, and stay listed in SHELL_WEB_FLOWS', () => {
    expect(SLOT_FLOWS.map((f) => f.id)).toEqual(['F01', 'F02', 'F03', 'F04']);
    const map = fs.readFileSync(path.resolve(__dirname, '../../../docs/e2e/feature-map.md'), 'utf8');
    for (const flow of SLOT_FLOWS) {
      const card = map.slice(map.indexOf(`### ${flow.id} —`), map.indexOf('### F', map.indexOf(`### ${flow.id} —`) + 5));
      expect(flow.probe, `${flow.id} needs the step-0 calendar precondition probe`).toBeTypeOf('function');
      for (const step of flow.steps.filter((s) => !s.text.startsWith('核对可观测量'))) {
        const sentence = step.text.replace(/。$/, '');
        expect(card, `${flow.id}: ${step.text}`).toContain(sentence);
      }
    }
    // 挂靠模式不改变归属：F01-F04 仍是 shell 流程，也不进夜间跑批的 CORE_FLOW_IDS
    expect(SHELL_WEB_FLOWS.filter((f) => ['F01', 'F02', 'F03', 'F04'].includes(f.id)).map((f) => f.id)).toEqual(['F01', 'F02', 'F03', 'F04']);
    expect(CORE_FLOW_IDS).toEqual(['F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F14', 'F15', 'F16', 'F17', 'F18']);
  });

  // ── step 0 探针 × 假槽（fixture 服务）─────────────────────────────────────
  describe('step 0 calendar precondition probe against a fixture slot', () => {
    const fullAccess = [{ id: 'calendar', connected: true, readiness: 'ready', detailCode: 'ready' }];
    const withDetail = (detailCode: string) => [{ id: 'calendar', connected: false, readiness: 'unchecked', detailCode }];
    let fixture: http.Server;
    let port: number;
    let savedCalendarVar: string | undefined;

    const startFixture = (data: unknown): Promise<number> => new Promise((resolve) => {
      fixture = http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, data }));
      });
      fixture.listen(0, '127.0.0.1', () => resolve((fixture.address() as { port: number }).port));
    });

    /** 跑公开流程对象的 step 0 探针（F01.probe），返回红/绿与 note。 */
    async function probe(data: unknown): Promise<{ error: Error | null; notes: string[]; marker: string }> {
      port = await startFixture(data);
      const notes: string[] = [];
      const env = { server: { port, token: 't' }, scratch: {}, note: (t: string) => notes.push(t) } as unknown as AttemptEnv;
      let error: Error | null = null;
      try {
        await slotFlow('F01').probe?.(env);
      } catch (e) {
        error = e as Error;
      }
      return { error, notes, marker: String(env.scratch.marker ?? '') };
    }

    beforeEach(() => {
      savedCalendarVar = process.env.NEO_E2E_CALENDAR;
      process.env.NEO_E2E_CALENDAR = 'Neo E2E 专属日历';
    });
    afterEach(async () => {
      if (savedCalendarVar === undefined) delete process.env.NEO_E2E_CALENDAR;
      else process.env.NEO_E2E_CALENDAR = savedCalendarVar;
      await new Promise<void>((resolve) => fixture?.close(() => resolve()));
    });

    it('passes on full access and seeds the attempt with the dedicated calendar and an E2E run marker', async () => {
      const { error, notes, marker } = await probe(fullAccess);
      expect(error).toBeNull();
      expect(marker).toMatch(/^E2E-[0-9a-f]{6}$/);
      expect(notes.join('\n')).toContain('完全访问');
    });

    it.each(['calendar_undecided', 'calendar_denied', 'calendar_write_only', 'calendar_restricted', 'calendar_desktop_only'])(
      'fails with the exact red step text and the raw status JSON when the slot reports %s',
      async (detailCode) => {
        const { error, notes } = await probe(withDetail(detailCode));
        expect(error?.message).toBe('前置：日历未授权');
        expect(notes.join('\n')).toContain(JSON.stringify(withDetail(detailCode)));
      },
    );

    it('fails with the exact red step text when the calendar connector is not in the slot status list at all', async () => {
      const { error, notes } = await probe([{ id: 'mail', connected: false, readiness: 'unchecked', detailCode: 'unchecked' }]);
      expect(error?.message).toBe('前置：日历未授权');
      expect(notes.join('\n')).toContain('mail');
    });

    it('fails with the exact no-dedicated-calendar text before anything else when NEO_E2E_CALENDAR is unset', async () => {
      delete process.env.NEO_E2E_CALENDAR;
      const { error } = await probe(fullAccess);
      expect(error?.message).toBe('precondition: no dedicated calendar (NEO_E2E_CALENDAR)');
    });
  });

  // ── 写安全护栏 × 手工构造的 db 快照 ───────────────────────────────────────
  describe('calendar write safety against crafted db snapshots', () => {
    const CALENDAR = 'Neo E2E 专属日历';
    const MARKER = 'E2E-abc123';
    const writeCheck = slotFlow('F01').steps[slotFlow('F01').steps.length - 1];

    const base = (calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>, events: Array<Record<string, unknown>>): DbSnapshot => ({
      sessions: [{ id: 's1' }],
      messages: [
        { session_id: 's1', tool_calls: JSON.stringify(calls) },
        { session_id: 's1', role: 'assistant', content: '已在专属日历创建评审会。' },
      ],
      toolEvents: events,
      pendingApprovals: [],
      permissionDecisions: [{ session_id: 's1', tool_name: calls[0]?.name, final_outcome: 'allow' }],
      cronJobs: [],
      cronExecutions: [],
    });
    const createCall = (args: Record<string, unknown>) => base(
      [{ id: 'c1', name: 'calendar_create_event', arguments: args }],
      [
        { session_id: 's1', tool_name: 'calendar_create_event', tool_call_id: 'c1', phase: 'begin' },
        { session_id: 's1', tool_name: 'calendar_create_event', tool_call_id: 'c1', phase: 'complete', status: 'success' },
      ],
    );

    function envWith(data: DbSnapshot): AttemptEnv {
      const env = {
        server: { port: 0, token: '' },
        sessionIds: ['s1'],
        scratch: { calendar: CALENDAR, marker: MARKER },
        note: () => {},
        readDb: async () => ({ file: 'crafted-db.json', data }),
      } as unknown as AttemptEnv;
      return env;
    }

    it('passes a create that targets the dedicated calendar and carries the run marker', async () => {
      await expect(writeCheck.run(envWith(createCall({ calendar: CALENDAR, title: `${MARKER} 评审会` })))).resolves.toBeUndefined();
    });

    it('fails a create that targets another calendar, even when the title carries the marker', async () => {
      await expect(writeCheck.run(envWith(createCall({ calendar: '个人', title: `${MARKER} 评审会` }))))
        .rejects.toThrow(/calendar 参数应为「Neo E2E 专属日历」.*"个人"/s);
    });

    it('fails a create with no calendar argument at all (it would land in the first writable calendar)', async () => {
      await expect(writeCheck.run(envWith(createCall({ title: `${MARKER} 评审会` }))))
        .rejects.toThrow(/calendar 参数应为「Neo E2E 专属日历」.*undefined/s);
    });

    it('fails a create whose title lacks the run marker', async () => {
      await expect(writeCheck.run(envWith(createCall({ calendar: CALENDAR, title: '评审会' }))))
        .rejects.toThrow(/标题缺运行标记 E2E-abc123/s);
    });

    it('fails an update that targets another calendar', async () => {
      const data = base(
        [{ id: 'u1', name: 'calendar_update_event', arguments: { calendar: '个人', title: `${MARKER} 评审会` } }],
        [{ session_id: 's1', tool_name: 'calendar_update_event', tool_call_id: 'u1', phase: 'complete', status: 'success' }],
      );
      await expect(writeCheck.run(envWith(data))).rejects.toThrow(/calendar_update_event.*calendar 参数应为「Neo E2E 专属日历」/s);
    });
  });
});
