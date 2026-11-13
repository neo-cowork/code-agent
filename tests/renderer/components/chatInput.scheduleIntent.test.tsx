// @vitest-environment jsdom

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateFromPrompt: vi.fn(),
  createJob: vi.fn(),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: { generateFromPrompt: mocks.generateFromPrompt, createJob: mocks.createJob },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: mocks.toast }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import {
  useChatInputSubmit,
  type UseChatInputSubmitParams,
} from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';
import { useScheduleDraft } from '../../../src/renderer/components/features/chat/ChatInput/useScheduleDraft';

const generatedDraft = {
  name: '每日邮件汇总',
  description: '每天汇总未读邮件',
  enabled: true,
  scheduleType: 'every',
  schedule: { type: 'every', interval: 1, unit: 'days' },
  action: { type: 'agent', agentType: 'default', prompt: '汇总未读邮件' },
  restatement: { what: '汇总未读邮件', notifyWhen: '有重要邮件' },
};

function makeParams(overrides: Partial<UseChatInputSubmitParams> = {}): UseChatInputSubmitParams {
  return {
    value: '',
    attachments: [],
    voiceInputContext: null,
    pendingAppshot: null,
    pendingPromptCommand: null,
    pendingAgentSelection: null,
    currentSessionId: 'session-1',
    isProcessing: false,
    disabled: false,
    isUploading: false,
    onSend: vi.fn().mockResolvedValue(true),
    agentEntries: [],
    buildEnvelope: vi.fn((content: string) => ({ content })) as never,
    openAgentCommand: vi.fn(),
    addToInputHistory: vi.fn(),
    clearAppshot: vi.fn(),
    inputAreaRef: { current: { focus: vi.fn() } } as React.RefObject<any>,
    setValue: vi.fn(),
    setAttachments: vi.fn(),
    setVoiceInputContext: vi.fn(),
    setPendingPromptCommand: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setScheduleComposerOpen: vi.fn(),
    openGoalConfirm: vi.fn(),
    closeGoalConfirm: vi.fn(),
    openSeedComposer: vi.fn(),
    setActiveAgentId: vi.fn(),
    ...overrides,
  };
}

function setup(value: string, overrides: Partial<UseChatInputSubmitParams> = {}) {
  const params = makeParams({ value, ...overrides });
  const hook = renderHook(
    (props: { value: string }) => {
      const schedule = useScheduleDraft('session-1');
      const submit = useChatInputSubmit({ ...params, value: props.value, scheduleDraft: schedule });
      return { ...schedule, ...submit };
    },
    { initialProps: { value } },
  );
  return { params, ...hook };
}

describe('natural-language scheduled task intent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateFromPrompt.mockResolvedValue(generatedDraft);
  });

  it.each([
    '帮我建一个定时任务：每天早上9点汇总未读邮件',
    '每周五下午5点帮我自动生成周报，建成定时任务',
    '明天下午3点帮我跑一次竞品价格检查，建个一次性定时任务',
    'Create a scheduled task that summarizes my inbox every day at 9am',
    'Please schedule a task to send me the weekly report every Friday',

    '提醒我明早9点交报告',
    // 隐式路径已按负责人决定整体删除：没有明说「建定时任务」的一律交模型（有意记录于此）
    '每周一早上9点提醒我交周报',
    '每个工作日下午6点提醒我写日报',
    '每月1号上午10点帮我生成月度报表',
    '每天早上9点自动帮我汇总未读邮件',
    'Every Monday at 9am please remind me to submit the weekly report',
    '每天早上9点给我打电话的那个客户是谁',
    '每天下午3点帮我看的那份报表是谁做的',
    'remind me to submit the report tomorrow at 9',
    '提醒我每天9点喝水',
    '怎么写一个定时任务调度器？',
    '帮我写一个每天9点运行的 node-cron 脚本',
    'how do I create a scheduled task in cron?',
    '取消我的定时任务',
    '暂停每天早上的定时任务',
    '列出所有定时任务',
    '修改定时任务的时间',
    '给这个项目加上自动化测试',
    '帮我开发一个自动化测试工具',
    '配置一下 CI 自动化部署流水线',
    '开启每天的定时任务',
    '每天的自动备份失败了，帮我看看日志',
    '每天自动构建都报错，帮我排查一下',
    'add automation tests to this repo',
    '帮我统计每个月的销售额',
    '帮我汇总一下每周的周报数据',
    '帮我整理每天的会议纪要',
    '帮我检查一下每天的销售数据有没有异常',
    '帮我生成每周的数据报表 PPT',
    '帮我跑一下每小时的数据',
    '每天早上9点自动发送的邮件没收到',
    '每天早上9点自动生成的日报内容不对',
    '帮我看看每天早上8点自动备份的文件在哪',
    '分析一下每天下午3点自动汇总的数据趋势',
    '明天下午3点有什么安排',
    '每周五下午5点的会议室被占了',
    'check every day at 9 the sales numbers I sent you and summarize them',
    'make the nightly cron job stop failing',
    `帮我建一个定时任务：${'每天汇总邮件，'.repeat(60)}`,
  ])('does not intercept: %s', async (sentence) => {
    const { params, result } = setup(sentence);
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(mocks.generateFromPrompt).not.toHaveBeenCalled();
    expect(params.onSend).toHaveBeenCalledTimes(1);
    expect(vi.mocked(params.onSend).mock.calls[0][0]).toMatchObject({ content: sentence });
    expect(result.current.pendingScheduleDraft).toBeNull();
  });

  it('does not intercept with attachments, a command chip context or steer', async () => {
    const sentence = '帮我建一个定时任务：每天早上9点汇总未读邮件';
    const withAttachment = setup(sentence, {
      attachments: [{ id: 'a1', name: 'a.txt', path: '/tmp/a.txt' } as never],
    });
    await act(async () => {
      await withAttachment.result.current.handleSubmit();
    });
    const withAgent = setup(sentence, { pendingAgentSelection: { id: 'agent-1' } as never });
    await act(async () => {
      await withAgent.result.current.handleSubmit();
    });
    expect(mocks.generateFromPrompt).not.toHaveBeenCalled();
    expect(withAttachment.params.onSend).toHaveBeenCalledTimes(1);
  });

  it('still routes the explicit slash command to the confirm draft', async () => {
    const { params, result } = setup('/schedule 每天9点汇总邮件');
    await act(async () => { await result.current.handleSubmit(); });
    expect(mocks.generateFromPrompt).toHaveBeenCalledWith('每天9点汇总邮件');
    expect(params.onSend).not.toHaveBeenCalled();
    expect(result.current.pendingScheduleDraft).not.toBeNull();
  });
});
