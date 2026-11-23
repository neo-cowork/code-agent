import { describe, expect, it } from 'vitest';
import {
  addCronRunCostUsd,
  cronDailyCostTotals,
  cronDayCostKind,
  cronTodayYesterdayKeys,
  readWakeSkipFromResult,
  wakeSkipReasonText,
} from '../../../src/shared/cronRunLedger';

const texts = {
  silentLevel: '未运行：角色处于静默档，不主动醒来',
  dailyBudget: '未运行：今日唤醒次数已用满（{used}/{max}）',
  quietHours: '未运行：处于免打扰时段，本次不补',
  connectorLost: '未运行：{names} 已退出登录，重新连接后会继续',
  nameLanguage: 'zh' as const,
};

function skipInfo(skipReason: string) {
  return readWakeSkipFromResult({ status: 'skipped', skipReason })?.info ?? null;
}

describe('parseWakeSkipReason', () => {
  it('三个已知原因都解析成机读 kind', () => {
    expect(skipInfo('silent_level')?.kind).toBe('silent_level');
    expect(skipInfo('quiet_hours')?.kind).toBe('quiet_hours');
    expect(skipInfo('daily_budget_exceeded (3/3)')?.kind).toBe('daily_budget_exceeded');
  });

  it('daily_budget_exceeded 解析出已用/上限', () => {
    expect(skipInfo('daily_budget_exceeded (3/5)')).toMatchObject({ used: 3, max: 5 });
  });

  it('未登记原因返回 null（不猜）', () => {
    expect(skipInfo('on_fire')).toBeNull();
    expect(skipInfo('daily_budget_exceeded (x/y)')).toBeNull();
  });

  it('connector_lost 解析出连接器 id，不认识的尾巴不算', () => {
    expect(skipInfo('connector_lost:feishu')).toEqual({ kind: 'connector_lost', connectorIds: ['feishu'] });
    expect(skipInfo('connector_lost:feishu,tmeet')?.connectorIds).toEqual(['feishu', 'tmeet']);
    expect(skipInfo('connector_lost:')).toBeNull();
    expect(skipInfo('connector_lost:Feishu')).toBeNull();
  });
});

describe('readWakeSkipFromResult', () => {
  it('RoleWakeResult 的 skipped 形状命中', () => {
    const view = readWakeSkipFromResult({ roleId: 'r', trigger: 'cadence', status: 'skipped', skipReason: 'quiet_hours' });
    expect(view?.info?.kind).toBe('quiet_hours');
  });

  it('空产物的安静醒来是 completed，不算 skip', () => {
    expect(readWakeSkipFromResult({ roleId: 'r', trigger: 'cadence', status: 'completed', decision: 'silence' })).toBeNull();
  });

  it('heartbeat 的 skipped:true 形状不命中（无 status/skipReason 字段）', () => {
    expect(readWakeSkipFromResult({ skipped: true, reason: 'outside_active_hours' })).toBeNull();
  });

  it('未登记 skipReason 保留原文供展示回落', () => {
    const view = readWakeSkipFromResult({ roleId: 'r', trigger: 'cadence', status: 'skipped', skipReason: 'on_fire' });
    expect(view?.info).toBeNull();
    expect(view?.raw).toBe('on_fire');
  });
});

describe('wakeSkipReasonText', () => {
  it('{used}/{max} 占位符替换成读数', () => {
    expect(wakeSkipReasonText({ kind: 'daily_budget_exceeded', used: 3, max: 3 }, texts)).toBe('未运行：今日唤醒次数已用满（3/3）');
  });

  it('无数字的原因原样输出', () => {
    expect(wakeSkipReasonText({ kind: 'silent_level' }, texts)).toBe(texts.silentLevel);
  });

  it('connector_lost 用人话显示名，中英文都不露 id', () => {
    const info = { kind: 'connector_lost' as const, connectorIds: ['feishu', 'tmeet'] };
    expect(wakeSkipReasonText(info, texts)).toBe('未运行：飞书、腾讯会议 已退出登录，重新连接后会继续');
    expect(wakeSkipReasonText(info, {
      ...texts,
      nameLanguage: 'en',
      connectorLost: 'Not run: {names} signed out — it will resume after you reconnect',
    })).toBe('Not run: Feishu, Tencent Meeting signed out — it will resume after you reconnect');
    expect(wakeSkipReasonText({ kind: 'connector_lost', connectorIds: ['notion'] }, texts)).toBeNull();
    const shown = wakeSkipReasonText(info, texts) ?? '';
    expect(shown).not.toContain('feishu');
    expect(shown).not.toContain('tmeet');
  });
});

describe('cronDailyCostTotals', () => {
  it('日界按 startedAt 的本地日历日：23:59 与次日 00:01 分属两天', () => {
    const lateNight = new Date(2026, 9, 25, 23, 59).getTime();
    const earlyMorning = new Date(2026, 9, 26, 0, 1).getTime();
    const totals = cronDailyCostTotals([
      { scheduledAt: lateNight, startedAt: lateNight, cost: 0.01 },
      { scheduledAt: earlyMorning, startedAt: earlyMorning, cost: 0.02 },
    ]);
    expect(totals.map((bucket) => bucket.dayKey)).toEqual(['2026-10-26', '2026-10-25']);
    expect(totals[0].totalUsd).toBeCloseTo(0.02);
    expect(totals[1].totalUsd).toBeCloseTo(0.01);
  });

  it('startedAt 缺失回落 scheduledAt 归日', () => {
    const scheduledOnly = new Date(2026, 9, 24, 12).getTime();
    const totals = cronDailyCostTotals([{ scheduledAt: scheduledOnly, cost: 0.05 }]);
    expect(totals[0].dayKey).toBe('2026-10-24');
  });

  it('null cost 的运行计数但不加钱（无模型调用 → dash）', () => {
    const at = new Date(2026, 9, 26, 10).getTime();
    const totals = cronDailyCostTotals([
      { scheduledAt: at, startedAt: at, cost: undefined },
      { scheduledAt: at, startedAt: at, cost: 0.05 },
    ]);
    expect(totals[0].runCount).toBe(2);
    expect(totals[0].totalUsd).toBeCloseTo(0.05);
  });

  it('跳过的唤醒计入 skippedCount、不加钱', () => {
    const at = new Date(2026, 9, 26, 10).getTime();
    const totals = cronDailyCostTotals([
      { scheduledAt: at, startedAt: at, skipped: true },
      { scheduledAt: at, startedAt: at, cost: 0.04 },
    ]);
    expect(totals[0].skippedCount).toBe(1);
    expect(totals[0].runCount).toBe(2);
    expect(totals[0].totalUsd).toBeCloseTo(0.04);
  });

  it('云端运行不计入小计（本地无云端账单，单次显示 dash）', () => {
    const at = new Date(2026, 9, 26, 10).getTime();
    const totals = cronDailyCostTotals([
      { scheduledAt: at, startedAt: at, cost: 9, runsOn: 'cloud' },
      { scheduledAt: at, startedAt: at, cost: 0.04, runsOn: 'local' },
    ]);
    expect(totals[0].runCount).toBe(1);
    expect(totals[0].totalUsd).toBeCloseTo(0.04);
  });

  it('今天在前、最多 maxDays 天', () => {
    const entries = Array.from({ length: 8 }, (_, index) => {
      const at = new Date(2026, 9, 26 - index, 10).getTime();
      return { scheduledAt: at, startedAt: at, cost: 0.01 };
    });
    const totals = cronDailyCostTotals(entries);
    expect(totals).toHaveLength(7);
    expect(totals[0].dayKey).toBe('2026-10-26');
    expect(totals[6].dayKey).toBe('2026-10-20');
  });
});

describe('cronTodayYesterdayKeys', () => {
  it('月末/月初正确回退一天', () => {
    const { today, yesterday } = cronTodayYesterdayKeys(new Date(2026, 9, 1, 8).getTime());
    expect(today).toBe('2026-10-01');
    expect(yesterday).toBe('2026-09-30');
  });
});

describe('addCronRunCostUsd', () => {
  it('重试尝试累加到同一执行记录', () => {
    expect(addCronRunCostUsd(0.01, 0.02)).toBeCloseTo(0.03);
  });

  it('undefined 读数不覆盖已记账（重试簿记不冲销）', () => {
    expect(addCronRunCostUsd(0.01, undefined)).toBe(0.01);
  });

  it('首笔无读数保持 undefined（无模型调用 → dash）', () => {
    expect(addCronRunCostUsd(undefined, undefined)).toBeUndefined();
  });

  it('零/负读数不写入', () => {
    expect(addCronRunCostUsd(0.01, 0)).toBe(0.01);
    expect(addCronRunCostUsd(0.01, -1)).toBe(0.01);
  });
});

describe('flat-fee day classification (N-FIX-CRON-SUBSCRIPTION-COST-ALWAYS-UNRECORDED)', () => {
  const at = new Date(2026, 10, 13, 9).getTime();
  it('counts flat-fee runs without adding money; only-flat-fee day is flat-fee kind', () => {
    const [day] = cronDailyCostTotals([
      { scheduledAt: at, flatFee: true }, { scheduledAt: at, flatFee: true },
    ]);
    expect(day).toMatchObject({ totalUsd: 0, runCount: 2, flatFeeCount: 2 });
    expect(cronDayCostKind(day)).toBe('flat-fee');
  });
  it('mixed day keeps the priced USD sum and is usd kind', () => {
    const [day] = cronDailyCostTotals([{ scheduledAt: at, flatFee: true }, { scheduledAt: at, cost: 0.02 }]);
    expect(day.totalUsd).toBeCloseTo(0.02);
    expect(cronDayCostKind(day)).toBe('usd');
  });
  it('a day with no marker stays usd kind', () => {
    const [day] = cronDailyCostTotals([{ scheduledAt: at }]);
    expect(cronDayCostKind(day)).toBe('usd');
  });
});
