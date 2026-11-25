// @vitest-environment jsdom
// N-FIX-CRON-COPY-NAME-STALE-LOCATION-SUFFIX：「按新位置复制」草稿的自动位置后缀
// 恒与副本实际 runsOn 一致——剥来源名旧后缀、runsOn 变化时自动名跟随、保存后详情
// 标题与位置徽章同词。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeDomain: vi.fn(),
  on: vi.fn(() => () => undefined),
}));
const platform = vi.hoisted(() => ({ tauri: false }));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: ipc,
  invokeDomain: ipc.invokeDomain,
}));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({ useMcpServerStates: () => [] }));
vi.mock('../../../src/renderer/components/features/cron/useChannelCatalog', () => ({
  useChannelCatalog: () => ({ accounts: [], accountsLoading: false, conversationsByAccount: {} }),
  useEventScheduleNames: () => () => ({}),
}));
vi.mock('../../../src/renderer/components/features/cron/useMailSources', () => ({
  useMailSources: () => ({
    state: { status: 'empty', accounts: [], mailboxesByAccount: {} },
    reload: vi.fn(),
  }),
}));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    getGroupListenCheck: vi.fn().mockResolvedValue({ status: 'idle' }),
    startGroupListenCheck: vi.fn(),
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
    grantWriteScope: vi.fn(),
    revokeWriteScope: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pickNativeDirectory: vi.fn(),
}));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTauriMode: () => platform.tauri,
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';
import { stripLocationSuffix, withLocationSuffix } from '../../../src/renderer/components/features/cron/copyJobName';
import { cronCenterEn, cronCenterZh } from '../../../src/renderer/i18n/cronCenter';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const zh = cronCenterZh.cronCenter;
const en = cronCenterEn.cronCenter;
const ccOf = () => (useAppStore.getState().language === 'en' ? en : zh);

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-src',
    name: '每天 22:37 总结 notes.txt',
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

function renderCopy(copySource: CronJobDefinition): void {
  render(<CronJobEditor isOpen job={null} copySource={copySource} onClose={() => undefined} />);
}

async function saveCreate(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole('button', { name: ccOf().editorChrome.createTask }));
  fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));
  const createJob = useCronStore.getState().createJob as Mock;
  await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
  return createJob.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  ipc.invoke.mockReset();
  platform.tauri = false;
  useAppStore.setState({ language: 'zh' });
  useSessionStore.setState({ sessions: [] } as never);
  useCronStore.setState({
    jobs: [], latestExecutions: {}, executionsByJobId: {}, selectedJobId: null,
    createJob: vi.fn(), updateJob: vi.fn(), deleteJob: vi.fn(), triggerJob: vi.fn(),
    loadExecutions: vi.fn(), openEditEditor: vi.fn(), openCopyEditor: vi.fn(),
  } as never);
});

afterEach(() => cleanup());

describe('① 复制草稿名称后缀恒与副本 runsOn 一致', () => {
  it('zh：本机源复制 → 名字带「 (云端)」、runsOn cloud，保存载荷一致', async () => {
    renderCopy(makeJob({ runsOn: 'local' }));
    const input = await screen.findByDisplayValue(`每天 22:37 总结 notes.txt (${zh.locationCloud})`);
    console.log(`zh copy-of-local name input value=${(input as HTMLInputElement).value}`);
    const saved = await saveCreate();
    console.log(`zh copy-of-local createJob arg name=${saved.name} runsOn=${saved.runsOn}`);
    expect(saved.name).toBe(`每天 22:37 总结 notes.txt (${zh.locationCloud})`);
    expect(saved.runsOn).toBe('cloud');
  });

  it('zh：云端源复制 → 名字带「 (本地)」、runsOn local，保存载荷一致', async () => {
    renderCopy(makeJob({ runsOn: 'cloud' }));
    const input = await screen.findByDisplayValue(`每天 22:37 总结 notes.txt (${zh.locationLocal})`);
    console.log(`zh copy-of-cloud name input value=${(input as HTMLInputElement).value}`);
    const saved = await saveCreate();
    console.log(`zh copy-of-cloud createJob arg name=${saved.name} runsOn=${saved.runsOn}`);
    expect(saved.name).toBe(`每天 22:37 总结 notes.txt (${zh.locationLocal})`);
    expect(saved.runsOn).toBe('local');
  });

  it('en：local source → " (Cloud)"；cloud source → " (Local)"', async () => {
    useAppStore.setState({ language: 'en' });
    const source = makeJob({ name: 'Nightly notes digest', runsOn: 'local' });
    const { unmount } = render(<CronJobEditor isOpen job={null} copySource={source} onClose={() => undefined} />);
    const input = await screen.findByDisplayValue(`Nightly notes digest (${en.locationCloud})`);
    console.log(`en copy-of-local name input value=${(input as HTMLInputElement).value}`);
    const saved = await saveCreate();
    console.log(`en copy-of-local createJob arg name=${saved.name} runsOn=${saved.runsOn}`);
    expect(saved.name).toBe(`Nightly notes digest (${en.locationCloud})`);
    expect(saved.runsOn).toBe('cloud');
    unmount();

    (useCronStore.getState().createJob as Mock).mockClear();
    renderCopy(makeJob({ name: 'Nightly notes digest', runsOn: 'cloud' }));
    await screen.findByDisplayValue(`Nightly notes digest (${en.locationLocal})`);
    const savedCloud = await saveCreate();
    console.log(`en copy-of-cloud createJob arg name=${savedCloud.name} runsOn=${savedCloud.runsOn}`);
    expect(savedCloud.name).toBe(`Nightly notes digest (${en.locationLocal})`);
    expect(savedCloud.runsOn).toBe('local');
  });
});

describe('② 来源名已带位置后缀（副本再复制）：先剥旧后缀再加新的', () => {
  it('「X (云端)」云端源 → 「X (本地)」，不叠加', async () => {
    renderCopy(makeJob({ name: `X (${zh.locationCloud})`, runsOn: 'cloud' }));
    const input = await screen.findByDisplayValue(`X (${zh.locationLocal})`) as HTMLInputElement;
    console.log(`copy-of-copy name input value=${input.value}`);
    expect(input.value).not.toContain(`${zh.locationCloud}) (`);
    expect(input.value.match(/\(/g)?.length).toBe(1);
  });

  it('「X (Local)」本机源 → 「X (Cloud)」（跨语言旧后缀也剥）', async () => {
    useAppStore.setState({ language: 'en' });
    renderCopy(makeJob({ name: `X (${en.locationLocal})`, runsOn: 'local' }));
    const input = await screen.findByDisplayValue(`X (${en.locationCloud})`) as HTMLInputElement;
    console.log(`en copy-of-copy name input value=${input.value}`);
    expect(input.value.match(/\(/g)?.length).toBe(1);
  });

  it('非位置词括号「X (周报)」保留，再追加位置后缀', async () => {
    renderCopy(makeJob({ name: 'X (周报)', runsOn: 'local' }));
    await screen.findByDisplayValue(`X (周报) (${zh.locationCloud})`);
  });
});

describe('③ 编辑器里切换副本执行位置：自动后缀跟随，手改名不动', () => {
  it('自动名：本地副本切云端→名字换 (云端)，切回→(本地)，保存载荷后缀=runsOn', async () => {
    renderCopy(makeJob({ runsOn: 'cloud' }));
    const input = await screen.findByDisplayValue(`每天 22:37 总结 notes.txt (${zh.locationLocal})`) as HTMLInputElement;
    // 副本默认 local（来源 cloud 的反面）；切到云端，名字框跟到「 (云端)」。
    fireEvent.click(screen.getByTestId('cron-runs-on-cloud'));
    await waitFor(() => expect(input.value).toBe(`每天 22:37 总结 notes.txt (${zh.locationCloud})`));
    // 再切回本机，名字回到「 (本地)」。
    fireEvent.click(screen.getByTestId('cron-runs-on-local'));
    await waitFor(() => expect(input.value).toBe(`每天 22:37 总结 notes.txt (${zh.locationLocal})`));
    console.log(`after double flip name input value=${input.value}`);
    const saved = await saveCreate();
    console.log(`after flip+flipback createJob arg name=${saved.name} runsOn=${saved.runsOn}`);
    expect(saved.name).toBe(`每天 22:37 总结 notes.txt (${zh.locationLocal})`);
    expect(saved.runsOn).toBe('local');
    expect(saved.name).toContain(`(${zh.locationLocal})`);
  });

  it('用户手改过的名字：切位置后名字不变', async () => {
    renderCopy(makeJob({ runsOn: 'local' }));
    const input = await screen.findByDisplayValue(`每天 22:37 总结 notes.txt (${zh.locationCloud})`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '我自己的副本名' } });
    fireEvent.click(screen.getByTestId('cron-runs-on-local'));
    await waitFor(() => expect(input.value).toBe('我自己的副本名'));
    const saved = await saveCreate();
    console.log(`custom-name createJob arg name=${saved.name} runsOn=${saved.runsOn}`);
    expect(saved.name).toBe('我自己的副本名');
    expect(saved.runsOn).toBe('local');
  });
});

describe('④ 保存后详情标题与位置徽章一致（zh/en）', () => {
  // 复刻 FB-2965 场景：本机源副本默认去云端，用户切回本机（保工作文件夹）后保存。
  async function copyFlipBackAndSave(): Promise<CronJobDefinition> {
    renderCopy(makeJob({ name: 'Nightly notes digest', runsOn: 'local' }));
    fireEvent.click(screen.getByTestId('cron-runs-on-local'));
    const saved = await saveCreate();
    return { ...saved, id: 'job-copy', createdAt: 1, updatedAt: 2 } as CronJobDefinition;
  }

  it.each([
    ['zh', zh] as const,
    ['en', en] as const,
  ])('%s：详情标题后缀词 == 位置徽章词', async (language, cc) => {
    useAppStore.setState({ language });
    const job = await copyFlipBackAndSave();
    expect(job.runsOn).toBe('local');
    cleanup();
    render(<CronJobDetail job={job} />);
    const heading = await screen.findByRole('heading', { level: 3 });
    const pill = screen.getByTestId(`cron-runs-on-pill-${job.runsOn}`);
    console.log(`${language} detail title=${heading.textContent} pill=${pill.textContent}`);
    expect(heading.textContent).toBe(`Nightly notes digest (${cc.locationLocal})`);
    expect(pill.textContent).toContain(cc.locationLocal);
  });
});

describe('⑥ 复制流程可见文案（zh/en 弹窗全量扫描）', () => {
  const HAN_RE = /\p{Script=Han}/u;
  it.each([
    ['zh', zh] as const,
    ['en', en] as const,
  ])('%s：弹窗标题/名称框/位置区均为本地文案，无内部串', async (language, cc) => {
    useAppStore.setState({ language });
    renderCopy(makeJob({ name: 'Nightly notes digest', runsOn: 'local' }));
    await screen.findByDisplayValue(`Nightly notes digest (${cc.locationCloud})`);
    const dialog = screen.getByRole('dialog');
    console.log(`${language} copy dialog textContent >>>\n${dialog.textContent}\n<<<`);
    expect(dialog.textContent).toContain(cc.copyTitle);
    expect(dialog.textContent).toContain(cc.editorChrome.taskNameLabel);
    expect(dialog.textContent).toContain(cc.locationLocal);
    expect(dialog.textContent).toContain(cc.locationCloud);
    expect(dialog.textContent).not.toMatch(/undefined|\[object Object\]|runsOn|copySource|metadata|NaN/);
    if (language === 'en') expect(dialog.textContent).not.toMatch(HAN_RE);
  });
});

describe('copyJobName helper 单测', () => {
  it('stripLocationSuffix 只剥末尾一个位置词括号，四种词都认', () => {
    expect(stripLocationSuffix(`X (${zh.locationLocal})`)).toBe('X');
    expect(stripLocationSuffix(`X (${zh.locationCloud})`)).toBe('X');
    expect(stripLocationSuffix(`X (${en.locationLocal})`)).toBe('X');
    expect(stripLocationSuffix(`X (${en.locationCloud})`)).toBe('X');
    expect(stripLocationSuffix(`X (${zh.locationCloud}) (${zh.locationLocal})`)).toBe(`X (${zh.locationCloud})`);
    expect(stripLocationSuffix('X (周报)')).toBe('X (周报)');
    expect(stripLocationSuffix('X')).toBe('X');
    expect(stripLocationSuffix(`X(${zh.locationLocal})`)).toBe(`X(${zh.locationLocal})`);
  });

  it('withLocationSuffix 后缀词跟 runsOn，不跟来源', () => {
    expect(withLocationSuffix('X', 'local', zh)).toBe(`X (${zh.locationLocal})`);
    expect(withLocationSuffix('X', 'cloud', zh)).toBe(`X (${zh.locationCloud})`);
    expect(withLocationSuffix('X', 'local', en)).toBe(`X (${en.locationLocal})`);
    expect(withLocationSuffix('X', 'cloud', en)).toBe(`X (${en.locationCloud})`);
  });
});
