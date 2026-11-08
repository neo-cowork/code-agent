import { describe, expect, it } from 'vitest';
import {
  buildCronEventDecisionText,
  localizeDecisionText,
  type CronEventDecisionTextKey,
} from '../../src/shared/cronEventDecisionText';
import {
  describeEventScheduleRule,
  droppedEventDecisions,
  settleEventRunDecisions,
} from '../../src/host/cron/cronEventDecisions';

interface TemplateCase {
  key: CronEventDecisionTextKey;
  params?: Record<string, string | number>;
  stored: string;
  zh: string;
  en: string;
}

const cases: TemplateCase[] = [
  { key: 'channelChatRule', params: { account: 'a1', chat: 'c1' }, stored: 'channel message · account a1 · chat c1', zh: '通道消息 · 账号 a1 · 会话 c1', en: 'Channel message · account a1 · chat c1' },
  { key: 'channelAnyChatRule', params: { account: 'a1' }, stored: 'channel message · account a1 · any chat', zh: '通道消息 · 账号 a1 · 任意会话', en: 'Channel message · account a1 · any chat' },
  { key: 'mailRule', params: { account: '163', mailbox: 'INBOX' }, stored: 'mail message · account 163 · mailbox INBOX', zh: '邮件 · 账号 163 · 收件箱 INBOX', en: 'Mail · account 163 · inbox INBOX' },
  { key: 'webhookRule', stored: 'webhook delivery · per-job hook URL', zh: 'Webhook 投递 · 此自动化的专用链接', en: "Webhook delivery · this automation's dedicated link" },
  { key: 'missingDecisions', stored: 'run result carried no eventDecisions field', zh: '运行结果里没有逐事件判断', en: 'The run did not report a decision for each event' },
  { key: 'missingReason', stored: 'no per-event reason stated', zh: '模型没有说明每个事件的原因', en: 'The model gave no reason for this event' },
  { key: 'mismatchedDecisionIds', params: { ids: '163|INBOX|999' }, stored: 'stated decisions did not match this event id (stated ids: 163|INBOX|999)', zh: '模型给出的事件编号与这个事件不匹配', en: "The model's event reference did not match this event" },
  { key: 'queueOverflow', params: { limit: 200 }, stored: 'pending queue overflow (limit 200); oldest event dropped', zh: '待处理事件超过 200 条，最早的一条已丢弃', en: 'More than 200 events were waiting, so the oldest was dropped' },
  { key: 'carryLimit', params: { limit: 20 }, stored: 'per-run carry limit (20 events) exceeded', zh: '单次运行最多处理 20 个事件，超出的事件已丢弃', en: 'This run exceeded its 20-event limit, so the extra event was dropped' },
  { key: 'automationInactive', stored: 'automation was disabled or removed before the batch ran', zh: '这批事件运行前，自动化已停用或移除', en: 'The automation was disabled or removed before this batch ran' },
  { key: 'modelAct', stored: 'model chose to act', zh: '模型决定执行', en: 'The model chose to act' },
  { key: 'modelIgnore', stored: 'model chose to ignore', zh: '模型决定忽略', en: 'The model chose to ignore' },
  { key: 'runFailedWithCause', params: { status: 'failed', cause: 'provider timeout' }, stored: 'run failed: provider timeout', zh: '运行未完成（失败）：provider timeout', en: 'Run failed: provider timeout' },
  { key: 'runFailedWithoutCause', params: { status: 'failed to start' }, stored: 'run failed to start', zh: '运行未完成（未能启动）', en: 'Run failed to start' },
  { key: 'observeIntercepted', params: { why: 'no per-event reason stated' }, stored: 'outbound action intercepted in observe mode (no per-event reason stated)', zh: '这个事件本会触发对外操作，但仅观察模式已拦下；模型没有说明每个事件的原因', en: 'This event would have triggered an outbound action, but observe mode stopped it; The model gave no reason for this event' },
  { key: 'noOutboundAction', params: { why: 'no per-event reason stated' }, stored: 'no outbound action attempted (no per-event reason stated)', zh: '这个事件未触发任何对外操作；模型没有说明每个事件的原因', en: 'This event did not trigger any outbound action; The model gave no reason for this event' },
  { key: 'runQuiet', params: { why: 'no per-event reason stated' }, stored: 'run stayed quiet (no alert; no per-event reason stated)', zh: '本次运行未发出提醒；模型没有说明每个事件的原因', en: 'The run stayed quiet and sent no alert; The model gave no reason for this event' },
  { key: 'runReported', params: { why: 'no per-event reason stated' }, stored: 'run completed and reported (no per-event reason stated)', zh: '本次运行已完成并报告结果；模型没有说明每个事件的原因', en: 'The run completed and reported a result; The model gave no reason for this event' },
];

describe('cron event decision text table', () => {
  it.each(cases)('round-trips $key through the shared stored template', ({ key, params, stored, zh, en }) => {
    const built = buildCronEventDecisionText(key, params);
    expect(built).toBe(stored);
    expect(localizeDecisionText(built, 'zh')).toBe(zh);
    expect(localizeDecisionText(built, 'en')).toBe(en);
  });

  it('leaves model-stated reasons untouched in both languages', () => {
    const modelReason = '客户说下周再联系，不需要现在回复';
    expect(localizeDecisionText(modelReason, 'zh')).toBe(modelReason);
    expect(localizeDecisionText(modelReason, 'en')).toBe(modelReason);
  });

  it('does not treat model reasons beginning with run as host failure text', () => {
    const modelReason = 'run the weekly digest';
    expect(localizeDecisionText(modelReason, 'zh')).toBe(modelReason);
    expect(localizeDecisionText(modelReason, 'en')).toBe(modelReason);
  });

  it('keeps every host-stored template byte-identical to the pre-localization strings', () => {
    expect(describeEventScheduleRule({ type: 'event', source: 'channel', accountId: 'a1', chatId: 'c1', eventName: 'message' })).toBe('channel message · account a1 · chat c1');
    expect(describeEventScheduleRule({ type: 'event', source: 'channel', accountId: 'a1', eventName: 'message' })).toBe('channel message · account a1 · any chat');
    expect(describeEventScheduleRule({ type: 'event', source: 'connector', connector: 'mail', accountId: '163', mailbox: 'INBOX', eventName: 'message' })).toBe('mail message · account 163 · mailbox INBOX');
    expect(describeEventScheduleRule({ type: 'event', source: 'webhook', eventName: 'message' })).toBe('webhook delivery · per-job hook URL');

    expect(droppedEventDecisions('j', [
      { eventId: 'q', cause: 'queue_overflow' },
      { eventId: 'c', cause: 'carry_limit' },
      { eventId: 'i', cause: 'automation_inactive' },
    ]).map((row) => row.reason)).toEqual([
      'pending queue overflow (limit 200); oldest event dropped',
      'per-run carry limit (20 events) exceeded',
      'automation was disabled or removed before the batch ran',
    ]);

    const settle = (mode: 'observe' | 'auto', execution: unknown, observeActionCount = 0) => settleEventRunDecisions({
      jobId: 'j', mode, carriedEventIds: ['e'], dropped: [], execution,
      observeActionCount: () => observeActionCount,
    })[0].reason;
    expect(settle('auto', { id: 'r', status: 'failed', error: 'provider timeout' })).toBe('run failed: provider timeout');
    expect(settle('auto', undefined)).toBe('run failed to start');
    expect(settle('auto', { id: 'r', status: 'completed', result: { eventDecisions: [{ eventId: 'e', action: 'act', reason: '' }] } })).toBe('model chose to act');
    expect(settle('auto', { id: 'r', status: 'completed', result: { eventDecisions: [{ eventId: 'e', action: 'ignore', reason: '' }] } })).toBe('model chose to ignore');
    expect(settle('observe', { id: 'r', status: 'completed', result: { eventDecisions: [] } })).toBe('no outbound action attempted (no per-event reason stated)');
    expect(settle('observe', { id: 'r', status: 'completed', result: { eventDecisions: [] } }, 1)).toBe('outbound action intercepted in observe mode (no per-event reason stated)');
    expect(settle('auto', { id: 'r', status: 'completed', result: { skipped: true, eventDecisions: [] } })).toBe('run stayed quiet (no alert; no per-event reason stated)');
    expect(settle('auto', { id: 'r', status: 'completed', result: { eventDecisions: [] } })).toBe('run completed and reported (no per-event reason stated)');
    expect(settle('observe', { id: 'r', status: 'completed', result: null })).toBe('no outbound action attempted (run result carried no eventDecisions field)');
    expect(settle('observe', { id: 'r', status: 'completed', result: { eventDecisions: [{ eventId: 'other', action: 'ignore', reason: 'x' }] } })).toBe('no outbound action attempted (stated decisions did not match this event id (stated ids: other))');
  });
});
