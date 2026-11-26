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
import { CronWorkingFolderRow } from '../../../src/renderer/components/features/cron/CronWorkingFolderRow';
import { buildSimpleDraft } from '../../../src/renderer/components/features/cron/CronSimpleCreate';
import { buildCronJobInput } from '../../../src/renderer/components/features/cron/types';
import { useAppStore } from '../../../src/renderer/stores/appStore';
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
  useAppStore.setState({ language: 'zh' });
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

  it('家目录路径仍只显示最后一段，不折成 ~', async () => {
    const job = makeJob({ metadata: { workingDirectory: '/Users/me/Documents/My Notes' } });
    render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText('执行动作'));
    expect(screen.getByTestId('cron-working-folder-name').textContent).toBe('My Notes');
    expect(screen.getByTestId('cron-working-folder-name').getAttribute('title')).toBe('/Users/me/Documents/My Notes');
    expect(screen.queryByTestId('cron-working-folder-input')).toBeNull();
  });
});

describe('编辑器工作文件夹行（web 构建）', () => {
  it('退回路径输入框，输入后保存进 metadata', async () => {
    platform.tauri = false;
    render(<CronJobEditor isOpen job={makeJob()} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText('执行动作'));
    const folderInput = screen.getByTestId('cron-working-folder-input');
    fireEvent.focus(folderInput);
    fireEvent.change(folderInput, { target: { value: '/srv/notes' } });
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

describe('工作文件夹状态行：悬停折家目录，分隔符走文案', () => {
  const homeFolder = '/Users/demo/Documents/My Notes';
  const folded = '~/Documents/My Notes';
  const missingHint = '编辑任务，选一个文件夹，运行时才能读到里面的文件。';

  it('英文是 Working folder: notes，中文是工作文件夹：notes', () => {
    useAppStore.setState({ language: 'en' });
    const { unmount } = render(<CronJobWorkingFolderStatus job={makeJob({ metadata: { workingDirectory: '/Users/demo/notes' } })} />);
    expect(screen.getByTestId('cron-job-working-folder-label').textContent).toBe('Working folder: notes');
    unmount();
    useAppStore.setState({ language: 'zh' });
    render(<CronJobWorkingFolderStatus job={makeJob({ metadata: { workingDirectory: '/Users/demo/notes' } })} />);
    expect(screen.getByTestId('cron-job-working-folder-label').textContent).toBe('工作文件夹：notes');
  });

  it('家目录悬停折成 ~/Documents/My Notes，任务卡和运行详情都不含 /Users/ 与账号名', () => {
    const { unmount } = render(<CronJobWorkingFolderStatus job={makeJob({ metadata: { workingDirectory: homeFolder } })} />);
    const jobTitle = screen.getByTestId('cron-job-working-folder').getAttribute('title');
    expect(jobTitle).toBe(folded);
    expect(jobTitle).not.toContain('/Users/');
    expect(jobTitle).not.toContain('demo');
    unmount();
    useSessionStore.setState({ sessions: [{ id: 'run-notes', workingDirectory: homeFolder }] } as never);
    render(<CronRunWorkingFolderStatus sessionId="run-notes" runsOn="local" />);
    const runTitle = screen.getByTestId('cron-run-working-folder').getAttribute('title');
    expect(runTitle).toBe(folded);
    expect(runTitle).not.toContain('/Users/');
    expect(runTitle).not.toContain('demo');
    expect(screen.getByTestId('cron-run-working-folder-label').textContent).toBe('工作文件夹：My Notes');
  });

  it('不在家目录下的文件夹悬停保留完整路径', () => {
    render(<CronJobWorkingFolderStatus job={makeJob({ metadata: { workingDirectory: '/Volumes/Data/notes' } })} />);
    expect(screen.getByTestId('cron-job-working-folder').getAttribute('title')).toBe('/Volumes/Data/notes');
    expect(screen.getByTestId('cron-job-working-folder-label').textContent).toBe('工作文件夹：notes');
  });

  it('恰好是家目录时悬停折成 ~', () => {
    const { unmount } = render(<CronJobWorkingFolderStatus job={makeJob({ metadata: { workingDirectory: '/Users/demo' } })} />);
    expect(screen.getByTestId('cron-job-working-folder').getAttribute('title')).toBe('~');
    unmount();
    const { unmount: unmountLinux } = render(<CronJobWorkingFolderStatus job={makeJob({ metadata: { workingDirectory: '/home/demo' } })} />);
    expect(screen.getByTestId('cron-job-working-folder').getAttribute('title')).toBe('~');
    unmountLinux();
    render(<CronJobWorkingFolderStatus job={makeJob({ metadata: { workingDirectory: 'C:\\Users\\demo' } })} />);
    expect(screen.getByTestId('cron-job-working-folder').getAttribute('title')).toBe('~');
  });

  it('没选文件夹：列表卡没有 title，详情和运行详情的 title 仍是原来的提示', () => {
    const { unmount } = render(<CronJobWorkingFolderStatus job={makeJob()} />);
    expect(screen.getByTestId('cron-job-working-folder').getAttribute('title')).toBeNull();
    expect(screen.getByTestId('cron-job-working-folder').textContent).toContain('未选择工作文件夹');
    unmount();
    const { unmount: unmountDetail } = render(<CronJobWorkingFolderStatus job={makeJob()} showHint />);
    expect(screen.getByTestId('cron-job-working-folder').getAttribute('title')).toBe(missingHint);
    unmountDetail();
    useSessionStore.setState({ sessions: [{ id: 'run-empty' }] } as never);
    render(<CronRunWorkingFolderStatus sessionId="run-empty" runsOn="local" />);
    expect(screen.getByTestId('cron-run-working-folder').getAttribute('title')).toBe(missingHint);
    expect(screen.getByTestId('cron-run-working-folder').textContent).toContain('未选择工作文件夹');
  });

  it('英文没选文件夹的可见文案是 No working folder selected', () => {
    useAppStore.setState({ language: 'en' });
    const { unmount } = render(<CronJobWorkingFolderStatus job={makeJob()} />);
    expect(screen.getByTestId('cron-job-working-folder').textContent).toContain('No working folder selected');
    expect(screen.getByTestId('cron-job-working-folder').getAttribute('title')).toBeNull();
    unmount();
    render(<CronJobWorkingFolderStatus job={makeJob()} showHint />);
    expect(screen.getByTestId('cron-job-working-folder').getAttribute('title')).toBe('Edit the task and pick a folder so it can read the files inside.');
  });
});

describe('web 路径输入：输入中保留原文，失焦/保存才去空白', () => {
  let latest: Record<string, unknown> | undefined;
  const Harness: React.FC = () => {
    const [metadata, setMetadata] = React.useState<Record<string, unknown> | undefined>(undefined);
    latest = metadata;
    return <CronWorkingFolderRow runsOn="local" metadata={metadata} onMetadataChange={setMetadata} />;
  };
  const savedMetadata = () => buildCronJobInput({
    ...buildSimpleDraft('summarize notes', 'notes', { scheduleType: 'every', everyInterval: '1', everyUnit: 'hours' }),
    metadata: latest,
  }).metadata;
  // 环境里没有 user-event：逐字符 fireEvent.change，等价于 userEvent.type 的受控输入序列。
  const typeChars = (input: HTMLElement, text: string) => {
    for (const char of text) fireEvent.change(input, { target: { value: (input as HTMLInputElement).value + char } });
  };

  beforeEach(() => { platform.tauri = false; latest = undefined; });

  it('(a) 逐字输入 /Users/me/My Notes：聚焦时保留空格与完整路径，失焦后展示折成 ~，提交值不变', () => {
    render(<Harness />);
    const input = screen.getByTestId('cron-working-folder-input') as HTMLInputElement;
    fireEvent.focus(input);
    typeChars(input, '/Users/me/My Notes');
    expect(input.value).toBe('/Users/me/My Notes');
    expect(latest).toEqual({ workingDirectory: '/Users/me/My Notes' });
    fireEvent.blur(input);
    expect(input.value).toBe('~/My Notes');
    expect(input.value).not.toContain('/Users/');
    expect(latest).toEqual({ workingDirectory: '/Users/me/My Notes' });
  });

  it('(b) 首尾空白：失焦提交 /tmp/notes；未失焦直接保存也被规整', () => {
    render(<Harness />);
    const input = screen.getByTestId('cron-working-folder-input') as HTMLInputElement;
    fireEvent.focus(input);
    typeChars(input, '  /tmp/notes  ');
    expect(savedMetadata())
      .toEqual({ workingDirectory: '/tmp/notes' });
    fireEvent.blur(input);
    expect(latest).toEqual({ workingDirectory: '/tmp/notes' });
  });

  it('(c) 只有空格：视为没选文件夹（失焦清键，保存载荷不带该键）', () => {
    render(<Harness />);
    const input = screen.getByTestId('cron-working-folder-input') as HTMLInputElement;
    fireEvent.focus(input);
    typeChars(input, '   ');
    expect(savedMetadata()).toEqual({});
    fireEvent.blur(input);
    expect(latest).toBeUndefined();
  });

  it('Linux 家目录失焦后折成 ~，metadata 仍是完整路径', () => {
    render(<Harness />);
    const input = screen.getByTestId('cron-working-folder-input') as HTMLInputElement;
    fireEvent.focus(input);
    typeChars(input, '/home/demo/Documents/My Notes');
    expect(input.value).toBe('/home/demo/Documents/My Notes');
    fireEvent.blur(input);
    expect(input.value).toBe('~/Documents/My Notes');
    expect(latest).toEqual({ workingDirectory: '/home/demo/Documents/My Notes' });
  });

  it('Windows 家目录失焦后折成 ~，metadata 仍是完整路径', () => {
    render(<Harness />);
    const input = screen.getByTestId('cron-working-folder-input') as HTMLInputElement;
    const stored = 'C:\\Users\\demo\\Documents\\My Notes';
    fireEvent.focus(input);
    typeChars(input, stored);
    expect(input.value).toBe(stored);
    fireEvent.blur(input);
    expect(input.value).toBe('~\\Documents\\My Notes');
    expect(input.value).not.toContain('\\Users\\');
    expect(latest).toEqual({ workingDirectory: stored });
  });

  it('恰好是家目录：失焦后展示 ~，提交值仍是完整路径', () => {
    render(<Harness />);
    const input = screen.getByTestId('cron-working-folder-input') as HTMLInputElement;
    fireEvent.focus(input);
    typeChars(input, '/Users/demo');
    fireEvent.blur(input);
    expect(input.value).toBe('~');
    expect(latest).toEqual({ workingDirectory: '/Users/demo' });
  });

  it('不在家目录下的路径失焦后原样显示', () => {
    render(<Harness />);
    const input = screen.getByTestId('cron-working-folder-input') as HTMLInputElement;
    fireEvent.focus(input);
    typeChars(input, '/srv/shared/notes');
    fireEvent.blur(input);
    expect(input.value).toBe('/srv/shared/notes');
    expect(latest).toEqual({ workingDirectory: '/srv/shared/notes' });
  });

  it('再次聚焦显示完整路径，失焦又折回 ~', () => {
    render(<Harness />);
    const input = screen.getByTestId('cron-working-folder-input') as HTMLInputElement;
    fireEvent.focus(input);
    typeChars(input, '/Users/me/Documents/My Notes');
    fireEvent.blur(input);
    expect(input.value).toBe('~/Documents/My Notes');
    fireEvent.focus(input);
    expect(input.value).toBe('/Users/me/Documents/My Notes');
    expect(latest).toEqual({ workingDirectory: '/Users/me/Documents/My Notes' });
    fireEvent.blur(input);
    expect(input.value).toBe('~/Documents/My Notes');
    expect(latest).toEqual({ workingDirectory: '/Users/me/Documents/My Notes' });
  });

  it('带空格的 My Notes：输入过程与失焦展示都保留空格', () => {
    render(<Harness />);
    const input = screen.getByTestId('cron-working-folder-input') as HTMLInputElement;
    fireEvent.focus(input);
    typeChars(input, '/Users/me/My Notes');
    expect(input.value).toContain('My Notes');
    expect(latest).toEqual({ workingDirectory: '/Users/me/My Notes' });
    fireEvent.blur(input);
    expect(input.value).toBe('~/My Notes');
    expect(input.value).toContain('My Notes');
    expect(latest).toEqual({ workingDirectory: '/Users/me/My Notes' });
  });
});
