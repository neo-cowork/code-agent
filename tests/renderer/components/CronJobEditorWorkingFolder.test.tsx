// @vitest-environment jsdom
// N-FIX-CRON-NO-SOURCE-SESSION-NO-WORKDIR：编辑器「工作文件夹」行 + 任务卡/详情/运行详情的状态展示。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeDomain: vi.fn(),
  on: vi.fn(() => () => undefined),
}));
const picker = vi.hoisted(() => ({ pickNativeDirectory: vi.fn() }));
const platform = vi.hoisted(() => ({ tauri: false }));

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({ useMcpServerStates: () => [] }));
vi.mock('../../../src/renderer/services/tauriPluginFacade', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pickNativeDirectory: picker.pickNativeDirectory,
}));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTauriMode: () => platform.tauri,
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { CronJobWorkingFolderStatus, CronRunWorkingFolderStatus } from '../../../src/renderer/components/features/cron/CronWorkingFolderStatus';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-notes',
    name: 'Weekly notes',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'days' },
    action: { type: 'agent', agentType: 'default', prompt: 'summarize notes' },
    runsOn: 'local',
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

async function saveEdit(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByText('保存修改'));
  fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));
  const updateJob = useCronStore.getState().updateJob as Mock;
  await waitFor(() => expect(updateJob).toHaveBeenCalledTimes(1));
  return updateJob.mock.calls[0][1];
}

beforeEach(() => {
  ipc.invoke.mockReset();
  picker.pickNativeDirectory.mockReset();
  platform.tauri = true;
  useSessionStore.setState({ sessions: [] } as never);
  useCronStore.setState({
    jobs: [], latestExecutions: {}, executionsByJobId: {}, selectedJobId: null,
    createJob: vi.fn(), updateJob: vi.fn(), deleteJob: vi.fn(),
  } as never);
});

afterEach(() => cleanup());

describe('编辑器工作文件夹行（桌面壳）', () => {
  it('默认「未选择」；选择后显示文件夹名（完整路径在 tooltip），保存带进 metadata.workingDirectory 且保留其它 metadata', async () => {
    picker.pickNativeDirectory.mockResolvedValue('/Users/me/notes');
    const job = makeJob({ metadata: { sourceSessionId: 'src-1' } });
    render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText('执行动作'));

    expect(screen.getByTestId('cron-working-folder-name').textContent).toBe('未选择');
    fireEvent.click(screen.getByTestId('cron-working-folder-pick'));
    await waitFor(() => expect(screen.getByTestId('cron-working-folder-name').textContent).toBe('notes'));
    expect(screen.getByTestId('cron-working-folder-name').getAttribute('title')).toBe('/Users/me/notes');

    const input = await saveEdit();
    expect(input.metadata).toEqual({ sourceSessionId: 'src-1', workingDirectory: '/Users/me/notes' });
  });

  it('已有文件夹原样往返；清除后保存不再带该键', async () => {
    const job = makeJob({ metadata: { workingDirectory: '/Users/me/notes' } });
    render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText('执行动作'));
    expect(screen.getByTestId('cron-working-folder-name').textContent).toBe('notes');

    fireEvent.click(screen.getByTestId('cron-working-folder-clear'));
    expect(screen.getByTestId('cron-working-folder-name').textContent).toBe('未选择');
    const input = await saveEdit();
    expect(input.metadata).toEqual({});
  });

  it('无操作编辑：metadata.workingDirectory 原样回写', async () => {
    const job = makeJob({ metadata: { workingDirectory: '/Users/me/notes' } });
    render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
    await screen.findByDisplayValue('Weekly notes');
    const input = await saveEdit();
    expect(input.metadata).toEqual({ workingDirectory: '/Users/me/notes' });
  });

  it('云端任务不显示工作文件夹行', async () => {
    const job = makeJob({ runsOn: 'cloud' });
    render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText('执行动作'));
    expect(screen.queryByTestId('cron-working-folder-row')).toBeNull();
    expect(screen.queryByTestId('cron-working-folder-input')).toBeNull();
  });
});

describe('编辑器工作文件夹行（web 构建）', () => {
  it('退回路径输入框，输入后保存进 metadata', async () => {
    platform.tauri = false;
    render(<CronJobEditor isOpen job={makeJob()} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText('执行动作'));
    fireEvent.change(screen.getByTestId('cron-working-folder-input'), { target: { value: '/srv/notes' } });
    const input = await saveEdit();
    expect(input.metadata).toEqual({ workingDirectory: '/srv/notes' });
  });
});

describe('工作文件夹状态展示', () => {
  it('任务既无文件夹也无来源会话：显示「未选择工作文件夹」', () => {
    render(<CronJobWorkingFolderStatus job={makeJob()} showHint />);
    expect(screen.getByTestId('cron-job-working-folder').textContent).toContain('未选择工作文件夹');
  });

  it('任务文件夹：显示文件夹名；来源会话文件夹作为兜底', () => {
    const { unmount } = render(<CronJobWorkingFolderStatus job={makeJob({ metadata: { workingDirectory: '/Users/me/notes' } })} />);
    expect(screen.getByTestId('cron-job-working-folder').textContent).toContain('notes');
    unmount();
    useSessionStore.setState({ sessions: [{ id: 's1', workingDirectory: '/Users/me/chatdir' }] } as never);
    render(<CronJobWorkingFolderStatus job={makeJob({ metadata: { sourceSessionId: 's1' } })} />);
    expect(screen.getByTestId('cron-job-working-folder').textContent).toContain('chatdir');
  });

  it('状态文案完整显示：标签元素没有 truncate，窄列里提示另起一行', () => {
    useSessionStore.setState({ sessions: [{ id: 'run-1' }] } as never);
    render(<CronRunWorkingFolderStatus sessionId="run-1" runsOn="local" />);
    const label = screen.getByTestId('cron-run-working-folder-label');
    expect(label.textContent).toBe('未选择工作文件夹');
    expect(label.className).not.toContain('truncate');
    expect(screen.getByTestId('cron-run-working-folder').className).toContain('flex-wrap');
  });

  it('云端任务与非 agent 任务不渲染', () => {
    const { container } = render(<CronJobWorkingFolderStatus job={makeJob({ runsOn: 'cloud' })} />);
    expect(container.innerHTML).toBe('');
  });

  it('运行详情：运行会话没有文件夹显示「未选择工作文件夹」，有则显示名字', () => {
    useSessionStore.setState({ sessions: [{ id: 'run-1' }, { id: 'run-2', workingDirectory: '/Users/me/notes' }] } as never);
    const { unmount } = render(<CronRunWorkingFolderStatus sessionId="run-1" runsOn="local" />);
    expect(screen.getByTestId('cron-run-working-folder').textContent).toContain('未选择工作文件夹');
    unmount();
    render(<CronRunWorkingFolderStatus sessionId="run-2" runsOn="local" />);
    expect(screen.getByTestId('cron-run-working-folder').textContent).toContain('notes');
  });
});
