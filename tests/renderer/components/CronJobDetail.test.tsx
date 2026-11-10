// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    getGroupListenCheck: vi.fn().mockResolvedValue({ status: 'idle' }),
    startGroupListenCheck: vi.fn(),
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    grantWriteScope: vi.fn(),
    revokeWriteScope: vi.fn(),
  },
}));

import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';
import { getBuiltinJobDisplay } from '../../../src/renderer/components/features/cron/builtinJobDisplay';
import { formatActionSummary } from '../../../src/renderer/components/features/cron/types';
import { CRON_EVENT_TRIGGER } from '../../../src/shared/constants/cronEventTrigger';
import { MEMORY_CONSOLIDATION } from '../../../src/shared/constants/memory';
import { CronGroupListenChecks } from '../../../src/host/cron/cronGroupListenCheck';
import { CronGroupListenCheck } from '../../../src/renderer/components/features/cron/CronGroupListenCheck';
import { cronClient } from '../../../src/renderer/services/cronClient';
import { ChannelModal } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
  return {
    id: 'job-1',
    runsOn: 'local',
    name: '英语单词',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '30 8 * * *' },
    action: { type: 'agent', agentType: 'general', prompt: '每天推荐 5 个英语单词' },
    enabled: true,
    maxRetries: 3,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  useCronStore.setState({ isEditorOpen: false, editingJobId: null, copyingJobId: null });
});

describe('CronJobDetail', () => {
  it('masks credential-like text in action summaries while keeping ordinary text unchanged', () => {
    const cases = [
      ['run backup --password=hunter2xyz now', 'run backup --password=***REDACTED*** now'],
      ['password: hunter2xyz', 'password: ***REDACTED***'],
      ['token: abcd1234efgh', 'token: ***REDACTED***'],
      ['echo password policy', 'echo password policy'],
    ] as const;
    for (const [prompt, expected] of cases) {
      expect(formatActionSummary(makeJob({ action: { type: 'agent', agentType: 'default', prompt } }), 'zh'))
        .toBe(expected);
    }
    expect(formatActionSummary(makeJob({ action: { type: 'shell', command: 'echo password policy' } }), 'zh'))
      .toBe('echo password policy');
  });

  it('renders the masked agent prompt in the detail action row', () => {
    render(<CronJobDetail job={makeJob({
      action: { type: 'agent', agentType: 'default', prompt: 'back up notes --password=hunter2xyz' },
    })} />);
    const action = screen.getByTestId('cron-detail-action');
    expect(action.textContent).toContain('--password=***REDACTED***');
    expect(action.textContent).not.toContain('hunter2xyz');
  });

  it('业务网格显示下次运行时间', () => {
    const next = Date.now() + 3_600_000;
    render(<CronJobDetail job={makeJob({ nextRunAt: next })} />);
    const card = screen.getByTestId('cron-detail-next-run');
    expect(card.textContent).toContain('下次运行');
    expect(card.textContent).not.toContain('—');
  });

  it('停用任务的下次运行显示占位符', () => {
    render(<CronJobDetail job={makeJob({ enabled: false, nextRunAt: Date.now() + 3_600_000 })} />);
    expect(screen.getByTestId('cron-detail-next-run').textContent).toContain('—');
  });

  it('重试/超时等工程参数收进高级折叠区且默认收起', () => {
    render(<CronJobDetail job={makeJob({ timeout: 60_000 })} />);
    const advanced = screen.getByTestId('cron-detail-advanced');
    expect(advanced.tagName).toBe('DETAILS');
    expect((advanced as HTMLDetailsElement).open).toBe(false);
    // 工程参数在折叠区内部而不在业务网格
    expect(advanced.textContent).toContain('最大重试');
    expect(advanced.textContent).toContain('超时');
  });

  it('空态显示选择引导', () => {
    render(<CronJobDetail job={null} />);
    expect(screen.getByText('选择一个任务查看详情')).toBeTruthy();
  });

  it('无描述时显示引导文案而不是「暂无描述」占位', () => {
    render(<CronJobDetail job={makeJob({ description: undefined })} />);
    expect(screen.getByTestId('cron-detail-description-guide').textContent).toContain(
      '让 Neo 给这个任务写一句描述',
    );
  });

  it('有描述时正常显示描述、不出现引导文案', () => {
    render(<CronJobDetail job={makeJob({ description: '每天背 5 个单词' })} />);
    expect(screen.getByText('每天背 5 个单词')).toBeTruthy();
    expect(screen.queryByTestId('cron-detail-description-guide')).toBeNull();
  });

  it('执行位置只读展示冻结说明，复制出口打开新任务编辑态', () => {
    render(<CronJobDetail job={makeJob({ runsOn: 'cloud' })} />);
    expect(screen.getByTestId('cron-runs-on-pill-cloud').textContent).toContain('云端');
    expect(screen.getByText('创建后不可更改')).toBeTruthy();

    fireEvent.click(screen.getByTestId('cron-copy-by-location'));
    expect(useCronStore.getState()).toMatchObject({
      isEditorOpen: true,
      editingJobId: null,
      copyingJobId: 'job-1',
    });
  });

  it('本地 agent 任务显示文件写入授权面板；云端任务与 shell 动作不显示', () => {
    const local = render(<CronJobDetail job={makeJob({})} />);
    expect(screen.getByTestId('cron-write-scope-panel')).toBeTruthy();
    local.unmount();

    const cloud = render(<CronJobDetail job={makeJob({ runsOn: 'cloud' })} />);
    expect(screen.queryByTestId('cron-write-scope-panel')).toBeNull();
    cloud.unmount();

    const shell = render(
      <CronJobDetail job={makeJob({ action: { type: 'shell', command: 'echo hi' } })} />,
    );
    expect(screen.queryByTestId('cron-write-scope-panel')).toBeNull();
    shell.unmount();
  });

  // N-CRON-DETAIL-TIME-FORMAT-MIXED ②：中文界面详情时间统一 24 小时制带年份，
  // 不再跟机器 locale 出 12 小时制 / 月在前美式格式。
  it('中文界面下次运行/创建/更新用 24 小时制且带年份，无 AM/PM', () => {
    const initialLanguage = useAppStore.getState().language;
    useAppStore.setState({ language: 'zh' });
    try {
      const at = new Date(2026, 10, 9, 16, 5, 0).getTime();
      render(<CronJobDetail job={makeJob({ nextRunAt: at, createdAt: at, updatedAt: at })} />);
      const nextRun = screen.getByTestId('cron-detail-next-run');
      expect(nextRun.textContent).toContain('2026/11/09 16:05');
      expect(nextRun.textContent).not.toMatch(/AM|PM/);
      const advanced = screen.getByTestId('cron-detail-advanced');
      expect(advanced.textContent).toContain('2026/11/09 16:05');
      expect(advanced.textContent).not.toMatch(/AM|PM/);
    } finally {
      useAppStore.setState({ language: initialLanguage });
    }
  });

  it('任务时区不同于本机时，详情计划/下次运行同区显示并补充本机时间', () => {
    const initialTz = process.env.TZ;
    const initialLanguage = useAppStore.getState().language;
    process.env.TZ = 'America/Los_Angeles';
    useAppStore.setState({ language: 'zh' });
    try {
      render(<CronJobDetail job={makeJob({
        name: '每日前瞻',
        schedule: { type: 'cron', expression: '0 15 * * 1-5', timezone: 'Asia/Shanghai' },
        nextRunAt: Date.parse('2026-11-09T07:00:00Z'),
      })} />);
      expect(screen.getByTestId('cron-detail-next-run').textContent).toContain('2026/11/09 15:00（中国标准时间）');
      expect(screen.getByTestId('cron-detail-next-run').textContent).not.toContain('23:00');
      expect(screen.getByTestId('cron-detail-local-next-run').textContent).toBe('你本机的时间 2026/11/08 23:00');
      expect(screen.getByText('工作日 15:00（中国标准时间）')).toBeTruthy();
    } finally {
      if (initialTz === undefined) delete process.env.TZ;
      else process.env.TZ = initialTz;
      useAppStore.setState({ language: initialLanguage });
    }
  });

  it('同区或无效时区不显示本机对照行', () => {
    const initialTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const nextRunAt = Date.parse('2026-11-09T07:00:00Z');
      const { rerender } = render(<CronJobDetail job={makeJob({
        schedule: { type: 'cron', expression: '0 15 * * 1-5', timezone: 'America/Los_Angeles' },
        nextRunAt,
      })} />);
      expect(screen.queryByTestId('cron-detail-local-next-run')).toBeNull();
      rerender(<CronJobDetail job={makeJob({
        schedule: { type: 'cron', expression: '0 15 * * 1-5', timezone: 'Not/AZone' },
        nextRunAt,
      })} />);
      expect(screen.queryByTestId('cron-detail-local-next-run')).toBeNull();
    } finally {
      if (initialTz === undefined) delete process.env.TZ;
      else process.env.TZ = initialTz;
    }
  });
});

it('offers the self-check in the detail of a newly created group listener', async () => {
  render(<CronJobDetail job={makeJob({
    scheduleType: 'event', schedule: { type: 'event', source: 'channel', accountId: 'feishu-1', chatId: 'group-1', eventName: 'message' },
  })} />);
  expect(await screen.findByRole('button', { name: '发条测试消息' })).toBeTruthy();
});

describe('Group listener receipt check', () => {
  const job: CronJobDefinition = {
    id: 'job-1', name: 'Group check', enabled: true, runsOn: 'local', scheduleType: 'event',
    schedule: { type: 'event', source: 'channel', accountId: 'account-1', chatId: 'group-1', eventName: 'message' },
    action: { type: 'agent', agentType: 'default', prompt: 'Summarize' },
    createdAt: 1, updatedAt: 1,
  };
  let checks: CronGroupListenChecks;
  const mount = async () => {
    await act(async () => { render(<CronGroupListenCheck jobId={job.id} />); });
  };
  const start = async () => {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发条测试消息' })); });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    checks = new CronGroupListenChecks(() => [job], Date.now);
    vi.mocked(cronClient.getGroupListenCheck).mockImplementation(async (id) => checks.get(id));
    vi.mocked(cronClient.startGroupListenCheck).mockImplementation(async (id) => checks.get(id, true));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  describe('Group listen self-check presentation', () => {
    it('offers instructions, waits after clicking and displays a real receipt as connected', async () => {
      await mount();
      expect(screen.getByText(/不要 @ 机器人/).textContent).toContain(`${CRON_EVENT_TRIGGER.GROUP_LISTEN_CHECK_MINUTES} 分钟`);
      expect(cronClient.startGroupListenCheck).not.toHaveBeenCalled();
      await start();
      expect(screen.getByRole('status').textContent).toBe('正在等待这个群的新消息…');
      checks.observe('account-1', {
        id: 'message-1', channelId: 'account-1', sender: { id: 'sender-1', name: 'Sender' },
        context: { chatId: 'group-1', chatType: 'group' }, content: 'test', timestamp: Date.now(),
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(CRON_EVENT_TRIGGER.GROUP_LISTEN_CHECK_POLL_MS); });
      expect(screen.getByRole('status').textContent).toBe('已连通');
      expect(screen.queryByText(/应用可能缺少/)).toBeNull();
    });

    it('shows the sensitive permission and admin publication path after timeout, then permits retry', async () => {
      await mount();
      await start();
      await act(async () => { await vi.advanceTimersByTimeAsync(CRON_EVENT_TRIGGER.GROUP_LISTEN_CHECK_MINUTES * 60_000); });
      expect(screen.getByRole('status').textContent).toContain('还没收到测试消息');
      const hint = screen.getByText(/应用可能缺少/).textContent;
      expect(hint).toContain('「获取群组中所有消息」');
      expect(hint).toContain('im:message.group_msg');
      expect(hint).toContain('敏感权限，需要租户管理员批准');
      expect(hint).toContain('飞书开放平台 → 应用 → 权限管理 → 搜索该权限 → 申请并发布版本');
      expect(screen.queryByText('已连通')).toBeNull();
      await start();
      expect(screen.getByRole('status').textContent).toBe('正在等待这个群的新消息…');
      expect(screen.queryByText(/应用可能缺少/)).toBeNull();
    });

    it('shows a retryable check error instead of reporting a missing permission on IPC failure', async () => {
      vi.mocked(cronClient.getGroupListenCheck).mockRejectedValueOnce(new Error('offline'));
      await mount();
      expect(screen.getByRole('status').textContent).toBe('暂时无法检查，请重试。');
      expect(screen.queryByText(/应用可能缺少/)).toBeNull();
      await start();
      expect(screen.getByRole('status').textContent).toBe('正在等待这个群的新消息…');
    });

    it('hides unsupported tasks and stops polling on unmount', async () => {
      vi.mocked(cronClient.getGroupListenCheck).mockResolvedValueOnce(null);
      await mount();
      expect(screen.queryByRole('button')).toBeNull();
      cleanup();
      await mount();
      await start();
      cleanup();
      const count = vi.mocked(cronClient.getGroupListenCheck).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(CRON_EVENT_TRIGGER.GROUP_LISTEN_CHECK_POLL_MS * 2); });
      expect(cronClient.getGroupListenCheck).toHaveBeenCalledTimes(count);
    });
  });

  describe('内置维护任务本地化展示（N-FIX-BUILTIN-CRON-JOB-ENGLISH-COPY）', () => {
    const initialLanguage = useAppStore.getState().language;
    afterEach(() => {
      useAppStore.setState({ language: initialLanguage });
      vi.restoreAllMocks();
    });

    const builtinMemoryJob = makeJob({
      id: 'builtin-mem',
      name: '[Maintenance] Light Memory consolidation',
      description: 'Compress ~/.code-agent/memory without losing information (quick model).',
      action: { type: 'memory-consolidation', dryRun: true },
      tags: [MEMORY_CONSOLIDATION.JOB_TAG],
    });

    const builtinDreamJob = makeJob({
      id: 'builtin-dream',
      name: '[Maintenance] Dream memory consolidation',
      description: 'Review recent sessions and write History-verified durable memory.',
      action: { type: 'agent', agentType: 'dream', prompt: '/dream --auto' },
      tags: ['dream-memory-consolidation'],
    });

    const builtinDistillJob = makeJob({
      id: 'builtin-distill',
      name: '[Maintenance] Distill workflow packaging',
      description: 'Review recent sessions and package repeated workflows into command/skill drafts.',
      action: { type: 'agent', agentType: 'distill', prompt: '/distill --auto' },
      tags: ['distill-workflow-packaging'],
    });

    const userJob = makeJob({
      id: 'user-job',
      name: '每日英语单词',
      description: '每天早上背 5 个单词',
      action: { type: 'agent', agentType: 'default', prompt: '推荐 5 个单词' },
      tags: ['study'],
    });

    it('中文界面下内置记忆任务详情显示「记忆整理」、一句无路径中文描述、动作「整理记忆」，删除确认使用中文名', () => {
      useAppStore.setState({ language: 'zh' });
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const { container } = render(<CronJobDetail job={builtinMemoryJob} />);

      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('记忆整理');
      expect(screen.getByText('定期整理你的记忆文件，合并重复内容，不会丢失信息。')).toBeTruthy();
      expect(screen.getByTestId('cron-detail-action').textContent).toBe('动作整理记忆');
      expect(screen.getByTestId('cron-detail-action').textContent).not.toContain('memory-consolidation');
      expect(container.textContent).not.toContain('[Maintenance]');
      expect(container.textContent).not.toContain('Light Memory consolidation');
      expect(container.textContent).not.toContain('~/.code-agent/memory');

      fireEvent.click(screen.getByText('删除'));
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('记忆整理'));
    });

    it('英文界面下内置记忆任务详情保持英文原名与原描述，动作显示 "Memory consolidation" 而非 memory-consolidation', () => {
      useAppStore.setState({ language: 'en' });
      render(<CronJobDetail job={builtinMemoryJob} />);

      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('[Maintenance] Light Memory consolidation');
      expect(screen.getByText('Compress ~/.code-agent/memory without losing information (quick model).')).toBeTruthy();
      expect(screen.getByTestId('cron-detail-action').textContent).toBe('ActionMemory consolidation');
      expect(screen.getByTestId('cron-detail-action').textContent).not.toContain('memory-consolidation');
    });

    it('Dream 与 Distill 内置任务在中英文界面下按同口径映射名称、描述与动作，不暴露 /dream --auto 或 /distill --auto', () => {
      useAppStore.setState({ language: 'zh' });
      const { container, rerender } = render(<CronJobDetail job={builtinDreamJob} />);
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('回顾沉淀');
      expect(screen.getByText('定期回顾最近的对话，把经过核对的长期信息写进记忆。')).toBeTruthy();
      expect(screen.getByText('回顾对话')).toBeTruthy();
      expect(container.textContent).not.toContain('/dream --auto');

      rerender(<CronJobDetail job={builtinDistillJob} />);
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('流程提炼');
      expect(screen.getByText('定期回顾最近的对话，把反复出现的做法整理成可复用的命令或技能草稿。')).toBeTruthy();
      expect(screen.getByText('提炼流程')).toBeTruthy();
      expect(container.textContent).not.toContain('/distill --auto');

      useAppStore.setState({ language: 'en' });
      rerender(<CronJobDetail job={builtinDreamJob} />);
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('[Maintenance] Dream memory consolidation');
      expect(screen.getByText('Review conversations')).toBeTruthy();
      expect(container.textContent).not.toContain('/dream --auto');

      rerender(<CronJobDetail job={builtinDistillJob} />);
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('[Maintenance] Distill workflow packaging');
      expect(screen.getByText('Distill workflows')).toBeTruthy();
      expect(container.textContent).not.toContain('/distill --auto');
    });

    it('普通用户任务在中英文下均原样展示存储的名称、描述与动作', () => {
      useAppStore.setState({ language: 'zh' });
      const { rerender } = render(<CronJobDetail job={userJob} />);
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('每日英语单词');
      expect(screen.getByText('每天早上背 5 个单词')).toBeTruthy();
      expect(screen.getByText('推荐 5 个单词')).toBeTruthy();

      useAppStore.setState({ language: 'en' });
      rerender(<CronJobDetail job={userJob} />);
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('每日英语单词');
      expect(screen.getByText('每天早上背 5 个单词')).toBeTruthy();
      expect(screen.getByText('推荐 5 个单词')).toBeTruthy();
    });

    it('getBuiltinJobDisplay 与 formatActionSummary 纯函数覆盖三类内置任务及非内置任务', () => {
      expect(getBuiltinJobDisplay(builtinMemoryJob, 'zh')).toEqual({
        name: '记忆整理',
        description: '定期整理你的记忆文件，合并重复内容，不会丢失信息。',
        actionLabel: '整理记忆',
      });
      expect(getBuiltinJobDisplay(builtinMemoryJob, 'en')).toEqual({
        name: '[Maintenance] Light Memory consolidation',
        description: 'Compress ~/.code-agent/memory without losing information (quick model).',
        actionLabel: 'Memory consolidation',
      });
      expect(getBuiltinJobDisplay(builtinDreamJob, 'zh')).toEqual({
        name: '回顾沉淀',
        description: '定期回顾最近的对话，把经过核对的长期信息写进记忆。',
        actionLabel: '回顾对话',
      });
      expect(getBuiltinJobDisplay(builtinDreamJob, 'en')).toEqual({
        name: '[Maintenance] Dream memory consolidation',
        description: 'Review recent sessions and write History-verified durable memory.',
        actionLabel: 'Review conversations',
      });
      expect(getBuiltinJobDisplay(builtinDistillJob, 'zh')).toEqual({
        name: '流程提炼',
        description: '定期回顾最近的对话，把反复出现的做法整理成可复用的命令或技能草稿。',
        actionLabel: '提炼流程',
      });
      expect(getBuiltinJobDisplay(builtinDistillJob, 'en')).toEqual({
        name: '[Maintenance] Distill workflow packaging',
        description: 'Review recent sessions and package repeated workflows into command/skill drafts.',
        actionLabel: 'Distill workflows',
      });
      expect(getBuiltinJobDisplay(userJob, 'zh')).toBeNull();
      expect(getBuiltinJobDisplay(userJob, 'en')).toBeNull();
      expect(getBuiltinJobDisplay(makeJob({ tags: undefined }), 'zh')).toBeNull();

      expect(formatActionSummary(builtinMemoryJob, 'zh')).toBe('整理记忆');
      expect(formatActionSummary(builtinMemoryJob, 'en')).toBe('Memory consolidation');
      expect(formatActionSummary(builtinDreamJob, 'zh')).toBe('回顾对话');
      expect(formatActionSummary(builtinDreamJob, 'en')).toBe('Review conversations');
      expect(formatActionSummary(builtinDistillJob, 'zh')).toBe('提炼流程');
      expect(formatActionSummary(builtinDistillJob, 'en')).toBe('Distill workflows');
      expect(formatActionSummary(userJob, 'zh')).toBe('推荐 5 个单词');
    });
  });
});

describe('Feishu onboarding checklist', () => {
  const initialLanguage = useAppStore.getState().language;
  afterEach(() => {
    cleanup();
    useAppStore.setState({ language: initialLanguage });
  });

  describe('Feishu setup permission checklist', () => {
    it.each([
      ['zh', true], ['zh', false], ['en', true], ['en', false],
    ] as const)('shows approval and no-mention scope in %s (WebSocket=%s)', (language, useWebSocket) => {
      useAppStore.setState({ language });
      render(<ChannelModal
        account={{
          id: 'test-account', name: 'Test Feishu', type: 'feishu', status: 'disconnected', enabled: true, createdAt: 1,
          config: { type: 'feishu', appId: 'test-app', appSecret: '', useWebSocket },
        }}
        channelTypes={[{ type: 'feishu', name: 'Feishu' }]}
        onSave={vi.fn()} onClose={vi.fn()}
      />);
      const checklist = screen.getByRole('region', { name: language === 'zh' ? '权限清单' : 'Permission checklist' });
      expect(checklist.textContent).toContain('im:message.group_msg');
      expect(checklist.textContent).toContain(language === 'zh' ? '租户管理员批准' : 'tenant administrator approval');
      expect(checklist.textContent).toContain(language === 'zh' ? '仅在无需 @ 的群监听中需要' : 'only needed for group listening without @mentions');
      expect(checklist.textContent).toContain(language === 'zh' ? '申请并发布版本' : 'Request it and publish a version');
    });
  });
});

describe('CronJobDetail 启用被宿主拒绝（云端角色副本）', () => {
  it('启用旧停用云端角色副本被拒时显示本地化原因，不抛未处理 rejection', async () => {
    const updateJob = vi.fn().mockRejectedValue(
      new Error('Role-bound agent jobs cannot run on the cloud scheduler'),
    );
    useCronStore.setState({ updateJob } as never);
    render(
      <CronJobDetail
        job={makeJob({
          runsOn: 'cloud',
          enabled: false,
          action: { type: 'agent', agentType: 'general', prompt: 'x', roleId: 'role-muzhi' },
        })}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText('启用'));
    });
    expect(screen.getByTestId('cron-detail-toggle-error').textContent).toContain('只能在本机运行');
    expect(screen.getByTestId('cron-detail-toggle-error').textContent).not.toContain('Role-bound');
  });
});
