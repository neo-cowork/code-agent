// ============================================================================
// CronEventTrigger — 一句话预筛 + 每小时 run 上限（N-CRON-EVENT-PREFILTER-HOURLY-CAP）
// 真实内存 SQLite（决策台账 / 计数表 / 邮件水位），假时钟，注入假小模型。只走公开入口。
// ============================================================================
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const databaseState = vi.hoisted(() => ({ db: null as BetterSqlite3.Database | null }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => databaseState.db }),
}));

import { applySchema } from '../../../src/host/services/core/database/schema';
import type { ChannelMessage } from '../../../src/shared/contract/channel';
import type { CronExecutionTrigger, CronJobDefinition } from '../../../src/shared/contract/cron';
import { CronEventTrigger, type CronEventChannelSource, type CronEventTriggerHost } from '../../../src/host/cron/cronEventTrigger';
import type { CronPrefilterJudge } from '../../../src/host/cron/cronEventPrefilter';
import { loadCronEventStats } from '../../../src/host/cron/cronEventStats';
import { normalizeSchedule } from '../../../src/host/cron/cronNormalizers';
import { localizeDecisionText } from '../../../src/shared/cronEventDecisionText';
import type { CronMailReader } from '../../../src/host/cron/cronMailPoller';

const NOW = Date.UTC(2026, 10, 19, 8, 0, 0);
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const active: CronEventTrigger[] = [];

function job(schedule: Record<string, unknown> = {}, id = 'job-1'): CronJobDefinition {
  return {
    id,
    name: 'payment digest',
    scheduleType: 'event',
    schedule: {
      type: 'event', source: 'channel', accountId: 'acc-1', eventName: 'message',
      batchWindowSec: 10, minRunIntervalSec: 30, ...schedule,
    } as CronJobDefinition['schedule'],
    action: { type: 'agent', agentType: 'default', prompt: 'summarise payment chasing' },
    runsOn: 'local', maxRunBudget: 1, enabled: true, createdAt: NOW, updatedAt: NOW,
  };
}

function freshDb(definition: CronJobDefinition): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db, noopLogger);
  db.prepare(`
    INSERT INTO cron_jobs (id, name, schedule_type, schedule, action, runs_on, max_run_budget, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(definition.id, definition.name, definition.scheduleType, JSON.stringify(definition.schedule),
    JSON.stringify(definition.action), definition.runsOn, definition.maxRunBudget, 1, NOW, NOW);
  return db;
}

function msg(id: string, content = `msg ${id}`): ChannelMessage {
  return {
    id, channelId: 'feishu', sender: { id: 'u1', name: '张三' },
    context: { chatId: 'chat-1', chatType: 'group' }, content, timestamp: NOW, ingressAuth: 'paired',
  } as ChannelMessage;
}

interface Run { trigger: CronExecutionTrigger; payloadBlock: string }

function harness(definition: CronJobDefinition, opts: {
  judge?: CronPrefilterJudge;
  inFlight?: () => boolean;
  mailReader?: CronMailReader;
} = {}) {
  databaseState.db ??= freshDb(definition);
  const source = new EventEmitter();
  const runs: Run[] = [];
  const host: CronEventTriggerHost = {
    getJobDefinitions: () => [definition],
    isJobInFlight: opts.inFlight ?? (() => false),
    executeEventJob: async (_d, trigger, payloadBlock) => { runs.push({ trigger, payloadBlock }); },
  };
  const trigger = new CronEventTrigger({
    host,
    channelSource: source as unknown as CronEventChannelSource,
    ...(opts.judge ? { prefilterJudge: opts.judge } : {}),
    ...(opts.mailReader ? { mailReader: opts.mailReader } : {}),
  });
  trigger.start();
  active.push(trigger);
  const emit = (id: string, content?: string) => source.emit('message', 'acc-1', msg(id, content));
  return { runs, emit, trigger };
}

function decisions(jobId = 'job-1') {
  return databaseState.db!.prepare(
    'SELECT event_id, decision, reason FROM cron_event_decisions WHERE job_id = ? ORDER BY created_at, rowid',
  ).all(jobId) as Array<{ event_id: string | null; decision: string; reason: string }>;
}

/** 假小模型：含「催款」的算符合，其余不符合；返回严格 JSON。 */
const keywordJudge: CronPrefilterJudge = async (prompt) => {
  const ids = JSON.parse(/事件 id 列表：(\[.*\])/.exec(prompt)![1]) as string[];
  const items = ids.map((id) => {
    const body = new RegExp(`id=${id} [^\\n]*\\n([^\\n]*)`).exec(prompt)?.[1] ?? '';
    return body.includes('催款')
      ? { id, match: true }
      : { id, match: false, reason: '不是催款消息' };
  });
  return { success: true, content: `好的：${JSON.stringify(items)}` };
};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => {
  for (const t of active.splice(0)) t.dispose();
  databaseState.db?.close();
  databaseState.db = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('① 每小时 run 上限', () => {
  it('100 条事件一小时内启动的 run 不超过上限，被推迟的事件不丢，窗口滑出后继续', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness(job({ maxRunsPerHour: 3 }));
    for (let i = 0; i < 100; i += 1) {
      h.emit(`e${i}`);
      await vi.advanceTimersByTimeAsync(35_000); // 100 × 35s ≈ 58 分钟
    }
    expect(h.runs.length).toBeLessThanOrEqual(3);
    expect(h.runs).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Hourly run cap reached for job job-1 (3/3)'));
    // 3 个 run 各带 1 条，其余 97 条里窗口内到达的都应被计为「被推迟」。
    expect(loadCronEventStats('job-1').heldByCap).toBeGreaterThan(50);
    expect(decisions().filter((row) => row.decision === 'dropped')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.runs.length).toBeGreaterThan(3);
    // 之后再过几个小时：被推迟的 97 条一条不丢，最终每个 id 都被某个 run 携带，且没有 carry_limit 丢弃。
    for (let hour = 0; hour < 8; hour += 1) await vi.advanceTimersByTimeAsync(3_600_000);
    const carriedIds = new Set(h.runs.flatMap((run) => run.trigger.eventIds ?? []));
    expect(carriedIds.size).toBe(100);
    expect(decisions().filter((row) => row.decision === 'dropped')).toHaveLength(0);
  });

  it('⑤ 上一趟 run 未结束时并发仍为 1：等它结束才起下一趟', async () => {
    let busy = true;
    const h = harness(job(), { inFlight: () => busy });
    h.emit('a');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.runs).toHaveLength(0);
    busy = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.runs).toHaveLength(1);
  });
});

describe('② ③ 预筛', () => {
  it('不符合的事件记 ignored 行并剔出批，符合的照常进 run；计数落库', async () => {
    const h = harness(job({ prefilter: '只处理客户催款的消息' }), { judge: keywordJudge });
    h.emit('p1', '客户催款：请尽快付款');
    h.emit('x1', '今晚吃什么');
    h.emit('p2', '催款提醒');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].trigger.eventIds).toEqual(['p1', 'p2']);
    expect(h.runs[0].payloadBlock).not.toContain('今晚吃什么');
    const skipped = decisions().filter((row) => row.reason.startsWith('skipped by prefilter'));
    expect(skipped).toEqual([{ event_id: 'x1', decision: 'ignored', reason: 'skipped by prefilter: 不是催款消息' }]);
    expect(localizeDecisionText(skipped[0].reason, 'zh')).toBe('预筛跳过：不是催款消息');
    expect(loadCronEventStats('job-1')).toEqual({ prefilterCalls: 1, prefilterSkipped: 1, heldByCap: 0 });
  });

  it('③ 整批都不符合：不启动 run，也不推进最小间隔时钟', async () => {
    const h = harness(job({ prefilter: '只处理客户催款的消息', minRunIntervalSec: 600 }), { judge: keywordJudge });
    h.emit('x1', '闲聊');
    h.emit('x2', '表情包');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.runs).toHaveLength(0);
    expect(decisions().map((row) => row.decision)).toEqual(['ignored', 'ignored']);
    // 间隔 600s：若时钟被推进，这条要等 10 分钟；没推进则 10s 合批窗后即起 run。
    h.emit('p1', '催款');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.runs).toHaveLength(1);
  });

  it('④ 小模型不可用：整批放行，留一条「没能判断」说明行并 warn 出原因', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const judge: CronPrefilterJudge = async () => ({ success: false, failureReason: 'not_configured', error: 'Quick model not configured' });
    const h = harness(job({ prefilter: '只处理客户催款的消息' }), { judge });
    h.emit('x1', '闲聊');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].trigger.eventIds).toEqual(['x1']);
    const note = decisions().find((row) => row.decision === 'unavailable' && row.event_id === null);
    expect(note?.reason).toBe('prefilter could not judge this batch (not_configured); ran it unfiltered');
    expect(localizeDecisionText(note!.reason, 'zh')).toContain('预筛没能判断这批消息');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cause: not_configured'));
  });

  it('④ 坏 JSON 同样放行并区分原因', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness(job({ prefilter: '只处理客户催款的消息' }), { judge: async () => ({ success: true, content: 'sorry' }) });
    h.emit('x1', '闲聊');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.runs).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cause: bad-json'));
  });
});

describe('归一化 round-trip', () => {
  it('prefilter 去空白截断，maxRunsPerHour 取整夹取；三种来源都保留', () => {
    const base = { type: 'event', eventName: 'message' };
    const channel = normalizeSchedule({ ...base, source: 'channel', accountId: 'a', prefilter: `  ${'x'.repeat(300)} `, maxRunsPerHour: 7.9 });
    expect(channel).toMatchObject({ maxRunsPerHour: 7 });
    expect((channel as { prefilter: string }).prefilter).toHaveLength(200);
    expect(normalizeSchedule({ ...base, source: 'channel', accountId: 'a', maxRunsPerHour: 0 })).toMatchObject({ maxRunsPerHour: 1 });
    expect(normalizeSchedule({ ...base, source: 'channel', accountId: 'a', maxRunsPerHour: 9999 })).toMatchObject({ maxRunsPerHour: 60 });
    expect(normalizeSchedule({ ...base, source: 'webhook', prefilter: 'p' })).toMatchObject({ prefilter: 'p' });
    expect(normalizeSchedule({ ...base, source: 'connector', connector: 'mail', accountId: 'a', prefilter: 'p', maxRunsPerHour: 5 }))
      .toMatchObject({ prefilter: 'p', maxRunsPerHour: 5 });
    expect(normalizeSchedule({ ...base, source: 'channel', accountId: 'a', prefilter: '   ' })).not.toHaveProperty('prefilter');
  });
});

describe('⑥ 游标：已见内容不会再交给 agent', () => {
  it('重复的渠道事件 id（含已跑完之后再投递）不再触发', async () => {
    const h = harness(job());
    h.emit('dup-1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    h.emit('dup-1', 'redelivered');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.runs).toHaveLength(1);
  });

  it('已在水位里的邮件 id 重启后不再交给 agent，只有新邮件进批', async () => {
    const mailJob = job({ source: 'connector', connector: 'mail', accountId: 'acct', mailbox: 'INBOX', pollIntervalSec: 30 }, 'mail-1');
    delete (mailJob.schedule as { chatId?: string }).chatId;
    const mails = [{ id: 1, subject: 'old mail', sender: 's@x', receivedAtMs: NOW, read: false }];
    const mailReader: CronMailReader = { listMessages: async () => [...mails], readMessage: async () => 'body' };
    const first = harness(mailJob, { mailReader });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(first.runs).toHaveLength(0);
    first.trigger.dispose();
    mails.push({ id: 2, subject: 'new mail', sender: 's@x', receivedAtMs: NOW, read: false });
    const second = harness(mailJob, { mailReader });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(second.runs).toHaveLength(1);
    expect(second.runs[0].payloadBlock).toContain('new mail');
    expect(second.runs[0].payloadBlock).not.toContain('old mail');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(second.runs).toHaveLength(1);
  });
});

describe('r2 评审回归', () => {
  it('邮件预筛看得到正文（先补取再预筛），且正文只读一遍', async () => {
    const mailJob = job({ source: 'connector', connector: 'mail', accountId: 'acct', mailbox: 'INBOX', pollIntervalSec: 30, prefilter: '只处理催款邮件' }, 'mail-pf');
    delete (mailJob.schedule as { chatId?: string }).chatId;
    const mails = [{ id: 1, subject: 'old', sender: 's@x', receivedAtMs: NOW, read: false }];
    const readMessage = vi.fn(async () => '正文：发票已逾期，请付款 BODY-MARKER');
    const prompts: string[] = [];
    const judge: CronPrefilterJudge = async (prompt) => {
      prompts.push(prompt);
      const id = JSON.parse(/事件 id 列表：(\[.*\])/.exec(prompt)![1])[0] as string;
      return { success: true, content: JSON.stringify([{ id, match: true }]) };
    };
    const h = harness(mailJob, { mailReader: { listMessages: async () => [...mails], readMessage }, judge });
    await vi.advanceTimersByTimeAsync(5_000);
    mails.push({ id: 2, subject: '账单', sender: 's@x', receivedAtMs: NOW, read: false });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('BODY-MARKER');
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].payloadBlock).toContain('BODY-MARKER');
    expect(readMessage).toHaveBeenCalledTimes(1);
  });

  it('预筛请求在飞时触发器被 dispose：返回后不再起 run', async () => {
    let release: (value: { success: boolean; content: string }) => void = () => undefined;
    const judge: CronPrefilterJudge = () => new Promise((resolve) => { release = resolve; });
    const h = harness(job({ prefilter: '只处理催款' }), { judge });
    h.emit('a1', '催款');
    await vi.advanceTimersByTimeAsync(10_000); // flush → 预筛请求已在飞
    h.trigger.dispose();
    release({ success: true, content: JSON.stringify([{ id: 'a1', match: true }]) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.runs).toHaveLength(0);
  });
});
