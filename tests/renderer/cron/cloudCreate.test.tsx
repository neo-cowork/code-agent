// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { ScheduleConfirmCard } from '../../../src/renderer/components/features/chat/ChatInput/ScheduleConfirmCard';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { CronHookError } from '../../../src/renderer/services/cronClient';
import { cronCenterZh, cronCenterEn } from '../../../src/renderer/i18n/cronCenter';

vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({ useMcpServerStates: () => [] }));
vi.mock('../../../src/renderer/services/rolesClient', () => ({ listRoles: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/renderer/services/projectClient', () => ({ listProjects: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(), on: vi.fn(() => () => undefined) },
  invokeDomain: vi.fn().mockResolvedValue({}),
}));
const create = vi.fn();
function control(label: string) {
  return screen.getByText(label).parentElement!.querySelector('input,textarea,select')!;
}
beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
  create.mockReset().mockRejectedValue(new CronHookError('internal sentinel', 'CRON_CLOUD_NOT_CONFIGURED'));
  useCronStore.setState({ jobs: [], createJob: create });
});
afterEach(cleanup);

describe('cloud creation recovery', () => {
  it('editor preserves its draft and one click changes only the execution location', async () => {
    render(<CronJobEditor isOpen job={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('手动配置'));
    fireEvent.change(control('任务名称'), { target: { value: 'GitHub 通知摘要' } });
    fireEvent.click(screen.getByText('执行动作'));
    // The default manual action is shell; choose an agent before selecting cloud.
    fireEvent.change(control('动作类型'), { target: { value: 'agent' } });
    const prompt = document.querySelector('textarea')!;
    fireEvent.change(prompt, { target: { value: '整理未读 GitHub 通知并发给我' } });
    fireEvent.click(screen.getByText('基本设置'));
    fireEvent.click(screen.getByText('云端', { exact: true }));
    fireEvent.click(screen.getByText('创建任务'));
    await screen.findByText(cronCenterZh.cronCenter.cloudCreate.unconfigured);
    expect(document.body.textContent).not.toContain('internal sentinel');
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ runsOn: 'cloud' }));
    fireEvent.click(screen.getByText(cronCenterZh.cronCenter.cloudCreate.switchLocal));
    expect((control('任务名称') as HTMLInputElement).value).toBe('GitHub 通知摘要');
    create.mockResolvedValue({ id: 'local-summary', runsOn: 'local' });
    fireEvent.click(screen.getByText('创建任务'));
    await waitFor(() => expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ runsOn: 'local', name: 'GitHub 通知摘要' })));
  });

  it.each(['zh', 'en'] as const)('chat card localizes the reason and preserves the task when switching (%s)', language => {
    useAppStore.setState({ language });
    const onDraftChange = vi.fn();
    const draft = {
      sourceSessionId: null, description: 'Summarize GitHub notifications',
      creationErrorCode: 'CRON_CLOUD_NOT_CONFIGURED',
      input: { name: 'GitHub summary', enabled: true, runsOn: 'cloud' as const,
        scheduleType: 'cron' as const, schedule: { type: 'cron' as const, expression: '0 9 * * 1-5' },
        action: { type: 'agent' as const, agentType: 'default' as const, prompt: 'Summarize unread notifications.' } },
    };
    render(<ScheduleConfirmCard draft={draft} confirming={false} onConfirm={vi.fn()} onDismiss={vi.fn()} onDraftChange={onDraftChange} />);
    const copy = (language === 'zh' ? cronCenterZh : cronCenterEn).cronCenter.cloudCreate;
    expect(screen.getByText(copy.unconfigured)).toBeTruthy();
    expect(screen.getByText(copy.settings)).toBeTruthy();
    fireEvent.click(screen.getByText(copy.switchLocal));
    expect(onDraftChange).toHaveBeenCalledWith({ ...draft, creationErrorCode: undefined, input: { ...draft.input, runsOn: 'local' } });
  });
});
