// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../../../src/renderer/components/primitives/Button';
import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { CronFeaturedTemplates } from '../../../src/renderer/components/features/cron/CronFeaturedTemplates';
import { ScheduleConfirmCard } from '../../../src/renderer/components/features/chat/ChatInput/ScheduleConfirmCard';
import { useScheduleDraft, type PendingScheduleDraft } from '../../../src/renderer/components/features/chat/ChatInput/useScheduleDraft';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

const state = vi.hoisted(() => ({ configured: false }));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({ useMcpServerStates: () => [] }));
vi.mock('../../../src/renderer/services/rolesClient', () => ({ listRoles: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/renderer/services/projectClient', () => ({ listProjects: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(), on: vi.fn(() => () => undefined) },
  invokeDomain: vi.fn(async (_domain: string, action: string) => {
    if (action === 'get') return state.configured ? { cronCloud: { baseUrl: 'https://cron.example.test' } } : {};
    if (action === 'getAllServiceKeys') return state.configured ? { 'neo-cron-cloud': 'masked-fixture' } : {};
    return undefined;
  }),
}));

const createJob = vi.fn();
const draft: PendingScheduleDraft = {
  sourceSessionId: 'summary-session', description: 'Summarize GitHub notifications every weekday',
  handoffPrompt: 'Review the summary together',
  creationErrorCode: 'CRON_CLOUD_NOT_CONFIGURED',
  input: { name: 'GitHub summary', enabled: true, runsOn: 'cloud', scheduleType: 'cron',
    schedule: { type: 'cron', expression: '0 9 * * 1-5' },
    action: { type: 'agent', agentType: 'default', prompt: 'Summarize unread GitHub notifications.' } },
};

function Composer() {
  const controller = useScheduleDraft(draft.sourceSessionId);
  return <>
    <Button onClick={() => controller.storePendingScheduleDraft(draft)}>Prepare summary</Button>
    {controller.pendingScheduleDraft && <>
      <output data-testid="pending-draft">{JSON.stringify(controller.pendingScheduleDraft)}</output>
      <ScheduleConfirmCard draft={controller.pendingScheduleDraft} confirming={false}
        onConfirm={vi.fn()} onDismiss={controller.discardPendingScheduleDraft}
        onDraftChange={controller.storePendingScheduleDraft} />
    </>}
  </>;
}

// Match App's page replacement: settings unmounts ChatInput; automation is a different page.
function AppPages() {
  const showSettings = useAppStore(s => s.showSettings);
  const showCronCenter = useAppStore(s => s.showCronCenter);
  return showSettings ? <Button onClick={() => useAppStore.getState().closeSettings()}>Close settings</Button>
    : showCronCenter ? <div>Automation center</div> : <Composer />;
}

beforeEach(() => {
  state.configured = false;
  useAppStore.getState().setShowSettings(false);
  useAppStore.setState({ language: 'zh', showCronCenter: false, settingsReturnTo: null });
  createJob.mockReset();
  useCronStore.setState({ jobs: [], createJob });
});
afterEach(() => { cleanup(); useAppStore.getState().setShowSettings(false); });

function control(label: string) {
  return screen.getByText(label).parentElement!.querySelector('input,textarea,select')!;
}

describe('PR #3083 Important regressions', () => {
  it('returns from cloud settings to chat with the same pending schedule after unmount', async () => {
    render(<AppPages />);
    fireEvent.click(screen.getByText('Prepare summary'));
    const before = JSON.parse(screen.getByTestId('pending-draft').textContent!);
    fireEvent.click(screen.getByText('去配置云端服务'));
    expect(screen.queryByTestId('pending-draft')).toBeNull();
    state.configured = true;
    fireEvent.click(screen.getByText('Close settings'));
    await waitFor(() => expect(screen.getByTestId('pending-draft')).toBeTruthy());
    expect(useAppStore.getState().showCronCenter).toBe(false);
    const restored = JSON.parse(screen.getByTestId('pending-draft').textContent!);
    expect(restored).toEqual({ ...before, creationErrorCode: undefined });
    await waitFor(() => expect(screen.queryByTestId('cron-cloud-create-notice')).toBeNull());
  });

  it('keeps the default non-chat settings return target when a notice button is clicked', async () => {
    createJob.mockRejectedValue(Object.assign(new Error('Cloud scheduler is not configured'), { code: 'CRON_CLOUD_NOT_CONFIGURED' }));
    render(<CronFeaturedTemplates />);
    fireEvent.click(screen.getByTestId('cron-featured-daily-lookahead'));
    fireEvent.click(await screen.findByText('去配置云端服务'));
    expect(useAppStore.getState().settingsReturnTo).toBe('cronCenter');
  });

  it.each(['manual editor', 'simple editor', 'featured template'])('preserves the host validation reason in %s', async entry => {
    const reason = '定时任务时间已过去，请改成将来的时间';
    createJob.mockRejectedValue(new Error(reason));
    if (entry === 'featured template') {
      render(<CronFeaturedTemplates />);
      fireEvent.click(screen.getByTestId('cron-featured-daily-lookahead'));
    } else {
      render(<CronJobEditor isOpen job={null} onClose={vi.fn()} />);
      if (entry === 'manual editor') {
        fireEvent.click(screen.getByText('手动配置'));
        fireEvent.change(control('任务名称'), { target: { value: 'GitHub 通知摘要' } });
        fireEvent.click(screen.getByText('执行动作'));
        fireEvent.change(control('动作类型'), { target: { value: 'agent' } });
        fireEvent.change(document.querySelector('textarea')!, { target: { value: '整理未读 GitHub 通知并发给我' } });
        fireEvent.click(screen.getByText('创建任务'));
      } else {
        fireEvent.change(screen.getByPlaceholderText('例如：读一遍我关注的竞品动态，整理成简报'), { target: { value: '整理未读 GitHub 通知并发给我' } });
        fireEvent.click(screen.getByText('创建自动化'));
      }
    }
    if (entry !== 'featured template') {
      expect(createJob).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));
    }
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(reason)).toBeTruthy();
  });
});
