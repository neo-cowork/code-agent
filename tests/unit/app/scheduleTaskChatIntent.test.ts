import { afterEach, describe, expect, it, vi } from 'vitest';
import { isScheduleTaskChatIntent } from '../../../src/host/app/scheduleTaskChatIntent';
import { getTextForegroundToolNamesForPrompt, getSessionCommandCenterTurnRulesForPrompt } from '../../../src/host/app/sessionCommandCenterBrain';
import { getDeferredToolsToPreloadForTurn } from '../../../src/host/agent/runtime/contextAssembly/deferredToolPreload';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { getConnectorRegistry } from '../../../src/host/connectors/registry';
import { ConnectorRegistry } from '../../../src/host/connectors/registry';

vi.mock('../../../src/host/services/core/configService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/core/configService')>();
  const config = Object.create(actual.getConfigService());
  config.getSettings = () => ({ connectors: { enabledNative: ['reminders'] } });
  return { ...actual, getConfigService: () => config };
});

const positives = [
  'create a scheduled task: every day at 9am turn yesterday’s sales sheet into a one-page summary',
  '每周五下午5点帮我把本周的会议纪要汇总成周报，建成定时任务',
  'schedule a one-time task for tomorrow 8am to export last month’s invoices',
  '每天早上9点汇总销售表', '每月1号自动生成报表', '每个工作日帮我导出报表',
  'automatically summarize sales every weekday', 'at 09:00 daily export invoices',
  'make this recurring', '创建自动化任务', '安排一次性任务：明天早上8点导出上个月的发票',
];

afterEach(() => vi.restoreAllMocks());

describe('scheduled-task exposure (never intercepts submission)', () => {
  it.each(positives)('foreground and preload both expose the registered tool: %s', (text) => {
    expect(isScheduleTaskChatIntent(text)).toBe(true);
    expect(getTextForegroundToolNamesForPrompt(text)).toContain('schedule_task');
    expect(getDeferredToolsToPreloadForTurn({
      enableToolDeferredLoading: true, messages: [{ id: 'u', role: 'user', content: text, timestamp: 1 }],
      turn: TurnState.forTest(),
    })).toContain('schedule_task');
  });

  it.each(['add automation tests to this repo', 'remind me tomorrow 3pm to call Mr Wang', '帮我明天下午3点提醒联系王先生', 'fix the backup error', 'hello'])('does not expose scheduling for %s', (text) => {
    expect(isScheduleTaskChatIntent(text)).toBe(false);
    expect(getTextForegroundToolNamesForPrompt(text)).not.toContain('schedule_task');
  });

  it('reminders suppression uses production foreground path and preserves one-shot reminders', () => {
    // Real native registry, platform-independent; no AppleScript is executed.
    const native = new ConnectorRegistry('darwin');
    native.configure(['reminders']);
    vi.spyOn(getConnectorRegistry(), 'get').mockImplementation((id) => native.get(id));
    const recurring = getTextForegroundToolNamesForPrompt('every day at 9am remind me to summarize sales');
    expect(recurring).toContain('schedule_task');
    expect(recurring.filter((name) => name.startsWith('reminders'))).toEqual([]);
    expect(getTextForegroundToolNamesForPrompt('每天9点提醒我汇总销售表')).not.toContain('reminders_create');
    expect(getTextForegroundToolNamesForPrompt('remind me tomorrow 3pm to call Mr Wang')).toContain('reminders_create');
  });

  it('loose exposure for how-to and failures only adds a per-turn model rule', () => {
    for (const text of ['how do I create a scheduled task in Neo?', 'the daily auto backup failed, check the log', 'delete my scheduled task']) {
      expect(getTextForegroundToolNamesForPrompt(text)).toContain('schedule_task');
      const rules = getSessionCommandCenterTurnRulesForPrompt(text).join('\n');
      expect(rules).toContain('不调用 schedule_task');
      expect(rules).toContain('用户确认前不创建任务');
    }
    expect(getSessionCommandCenterTurnRulesForPrompt('hello')).toEqual([]);
  });
});
