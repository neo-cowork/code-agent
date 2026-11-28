// @vitest-environment jsdom
// ============================================================================
// 设置 → 屏幕记忆：真 ScreenMemorySettings（桌面态，Tauri 开/关两种），只在 ipcService.invokeDomain 一处假宿主。
// ① 中文界面不出现 provider/daemon/MCP/Buffer/captures/Memory/entries/pid/system message/tokens/glob/ActivityContext/Tauri，
//    英文界面不出现 daemon/MCP/pid/provider（宿主 summary 与宿主原始报错里正好带着这些词，喂进去也不许上屏）。
// ③ 没装 OpenChronicle：一句未安装说明；开关/勾选/两个名单全锁；即使有 lastError 也没有红框；点开关不发 setEnabled。
// ④ 装了但启动失败：显示语言包里的一句话，宿主原文「openchronicle CLI not found」不进 DOM，原文进日志。
// ============================================================================
import React from 'react';
import fs from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../../src/shared/ipc';
import { DEFAULT_OPENCHRONICLE_SETTINGS, type OpenchronicleSettings, type OpenchronicleStatus } from '../../../../src/shared/contract/openchronicle';

const platform = vi.hoisted(() => ({ tauri: false, web: false }));
vi.mock('../../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/renderer/utils/platform')>()),
  isWebMode: () => platform.web,
  isDesktopShellMode: () => !platform.web,
  isTauriMode: () => platform.tauri,
}));

import ipcService from '../../../../src/renderer/services/ipcService';
import { ScreenMemorySettings } from '../../../../src/renderer/components/features/settings/tabs/ScreenMemorySettings';
import { useAppStore } from '../../../../src/renderer/stores/appStore';

const NOW = 1_795_000_000_000;
// 与 settingsRenderedJargon 同一预算：整页（含 Tauri 下的桌面活动区）在负载高的机器上首屏可能超过默认 1 秒。
const WAIT_MS = 10_000;

// 宿主 activityProviderRegistry.ts 当前原样返回的 summary/detail（含「Tauri app」「provider」「daemon」）。
const HOST_TEXT = {
  ocSummary: '长期后台屏幕记忆，负责跨 app 的默认上下文感知。',
  ocDetail: '外部 daemon 独立运行，code-agent 在注入 agent prompt 前做黑名单过滤。',
  nativeSummary: '内置在 Tauri app 里的手动桌面活动 provider，用于临时采集、会议音频和截图分析。',
  nativeDetail: '权限主体跟随 Tauri app，采集核心留在 bundled provider，音频和分析后续可以拆成 sidecar worker。',
  notInstalled: 'OpenChronicle 未安装',
  unhealthy: 'daemon started but MCP endpoint never became healthy',
  cliMissing: 'openchronicle CLI not found',
};

const COPY = {
  zh: {
    notInstalled: '这台电脑还没有安装屏幕记忆需要的配套程序 OpenChronicle，下面的开关暂时不能用。装好后点「刷新」即可。',
    runError: '屏幕记忆没有正常运行。请点「刷新」重新检查，还不行就把开关关掉再打开。',
    toggle: '启用屏幕记忆',
    autoInject: /新对话自动带上刚才在做的事/,
    apps: '应用（每行一个）',
    sites: '网站（每行一个，* 代表任意字符）',
    tileNotInstalled: '未安装',
    nothingYet: '还没有可以参考的屏幕内容。',
    webBody: '屏幕记忆要在你的电脑上持续记下你在各个应用里看过的内容，只有装在这台电脑上的 Agent Neo 桌面版能做到。',
  },
  en: {
    notInstalled: 'This computer does not have OpenChronicle, the companion program screen memory needs, so the switches below cannot be used yet. After installing it, press Refresh.',
    runError: 'Screen memory is not running properly. Press Refresh to check again; if that does not help, turn the switch off and on.',
    toggle: 'Enable screen memory',
    autoInject: /Start new chats with what you were just doing/,
    apps: 'Apps (one per line)',
    sites: 'Websites (one per line; * means any characters)',
    tileNotInstalled: 'Not installed',
    nothingYet: 'Nothing from your screen to refer to yet.',
    webBody: 'Screen memory keeps a record on your computer of what you look at across apps, which only the Agent Neo desktop app installed on that computer can do.',
  },
} as const;

type Lang = keyof typeof COPY;

const ZH_BANNED: Array<[string, RegExp]> = [
  ['provider', /provider/i],
  ['daemon', /daemon/i],
  ['MCP', /\bMCP\b/i],
  ['Buffer', /\bBuffer\b/i],
  ['captures', /\bcaptures?\b/i],
  ['Memory (label)', /\bMemory\b/],
  ['entries', /\bentries\b/i],
  ['pid', /\bpid\b/i],
  ['system message', /system\s+message/i],
  ['tokens', /\btokens?\b/i],
  ['glob', /\bglob\b/i],
  ['ActivityContext', /ActivityContext/i],
  ['Tauri', /tauri/i],
];
const EN_BANNED: Array<[string, RegExp]> = [
  ['daemon', /daemon/i],
  ['MCP', /\bMCP\b/i],
  ['pid', /\bpid\b/i],
  ['provider', /provider/i],
];

interface HostState {
  settings: OpenchronicleSettings;
  status: OpenchronicleStatus;
  activityContext: unknown;
  setEnabledResult: { ok: boolean; error?: string };
  statusAfterSetEnabled?: OpenchronicleStatus;
}

let host: HostState;
const calls: Array<[string, string, unknown]> = [];
// SCREEN_MEMORY_CENSUS_OUT=<file> 时把 ① 每个场景收到的全部文案落盘，供证据档逐条列出。
const census: Array<{ scenario: string; strings: string[] }> = [];

function providerList(status: OpenchronicleStatus) {
  return {
    generatedAtMs: NOW,
    providers: [
      {
        id: 'openchronicle',
        label: 'OpenChronicle',
        kind: 'daemon',
        state: status.state,
        captureSources: ['automatic-screen-memory'],
        lifecycle: 'always-on',
        contextRole: 'automatic-background',
        privacyBoundary: 'injection-filtered',
        summary: HOST_TEXT.ocSummary,
        detail: HOST_TEXT.ocDetail,
        lastError: status.lastError ?? null,
        metadata: {
          installed: status.installed,
          pid: status.pid ?? null,
          mcpHealthy: status.mcpHealthy,
          bufferFiles: status.bufferFiles ?? 0,
          memoryEntries: status.memoryEntries ?? 0,
        },
      },
      {
        id: 'tauri-native-desktop',
        label: 'Tauri Native Desktop',
        kind: 'bundled',
        state: 'available',
        captureSources: ['manual-desktop-session', 'meeting-audio', 'screenshot-analysis'],
        lifecycle: 'app-scoped',
        contextRole: 'manual-scene-capture',
        privacyBoundary: 'provider-filtered',
        summary: HOST_TEXT.nativeSummary,
        detail: HOST_TEXT.nativeDetail,
        lastActivityAtMs: null,
        lastError: null,
        metadata: { collectorRunning: false, audioCapturing: false },
      },
    ],
  };
}

// 宿主 buildActivityContext() 在这台机器（没装 OpenChronicle、没有桌面活动）上的形状：四个来源全 unavailable。
const HOST_UNAVAILABLE_REASONS = [
  'OpenChronicle context is empty or disabled',
  'No native desktop activity events available',
  'No audio segments found in the last hour',
  'No recent screenshot analysis available',
];
function unavailableSource(source: string, unavailableReason: string) {
  return { source, status: 'unavailable', confidence: 0, privacy: 'redacted', generatedAtMs: NOW, maxChars: 3000, text: null, items: [], evidenceRefs: [], unavailableReason };
}
const HOST_ACTIVITY_CONTEXT = {
  generatedAtMs: NOW,
  maxChars: 12_000,
  tokenBudgetHint: { maxChars: 12_000, targetTokens: 3000 },
  sources: ['openchronicle', 'tauri-native-desktop', 'audio', 'screenshot-analysis']
    .map((source, index) => unavailableSource(source, HOST_UNAVAILABLE_REASONS[index])),
  evidenceRefs: [],
};

async function fakeInvokeDomain(domain: string, action: string, payload?: unknown): Promise<unknown> {
  calls.push([domain, action, payload]);
  if (domain === IPC_DOMAINS.OPENCHRONICLE) {
    if (action === 'getSettings') return host.settings;
    if (action === 'getStatus') return host.status;
    if (action === 'updateSettings') return { success: true };
    if (action === 'setEnabled') {
      host.settings = { ...host.settings, enabled: (payload as { enabled: boolean }).enabled };
      if (host.statusAfterSetEnabled) host.status = host.statusAfterSetEnabled;
      return host.setEnabledResult;
    }
  }
  if (domain === IPC_DOMAINS.ACTIVITY) {
    if (action === 'listProviders') return providerList(host.status);
    if (action === 'getCurrentContext') return host.activityContext;
  }
  if (domain === IPC_DOMAINS.ENV_ASSIST && action === 'recheckSettingGrant') return { on: false };
  if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return {};
  return null;
}

const notInstalledStatus = (): OpenchronicleStatus => ({
  installed: false,
  state: 'stopped',
  mcpHealthy: false,
  lastError: HOST_TEXT.notInstalled,
});

const installedStatus = (): OpenchronicleStatus => ({
  installed: true,
  state: 'running',
  pid: 4321,
  mcpEndpoint: 'http://127.0.0.1:8742/mcp',
  mcpHealthy: true,
  bufferFiles: 3,
  memoryEntries: 12,
  lastError: HOST_TEXT.unhealthy,
});

function pageStrings(root: HTMLElement, options: { skipTextareaValues?: boolean } = {}): string[] {
  // 按文本节点逐个收，避免相邻文案拼接后漏判；再收 title / placeholder / aria-label。
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (options.skipTextareaValues && node.parentElement?.tagName === 'TEXTAREA') continue;
    texts.push(node.textContent ?? '');
  }
  for (const el of [root, ...Array.from(root.querySelectorAll('[title], [placeholder], [aria-label]'))]) {
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      const value = el.getAttribute(attr);
      if (value) texts.push(value);
    }
  }
  return texts.map((text) => text.trim()).filter(Boolean);
}

function bannedHits(strings: string[], banned: Array<[string, RegExp]>): string[] {
  return banned.flatMap(([word, re]) => strings.filter((text) => re.test(text)).map((text) => `${word}: ${text}`));
}

async function renderPage(lang: Lang, previewText: string = COPY[lang].nothingYet) {
  useAppStore.setState({ language: lang, cloudUIStrings: null });
  const view = render(<ScreenMemorySettings />);
  // 等状态回来（OpenchronicleSettings 的 getStatus）+ 预览读完（getCurrentContext）
  await waitFor(() => {
    expect(calls.some(([domain, action]) => domain === IPC_DOMAINS.OPENCHRONICLE && action === 'getStatus')).toBe(true);
    expect(view.container.textContent).toContain(previewText);
  }, { timeout: WAIT_MS });
  await waitFor(() => expect(screen.getByRole('switch', { name: COPY[lang].toggle })).toBeTruthy(), { timeout: WAIT_MS });
  await new Promise((resolve) => setTimeout(resolve, 50));
  return view;
}

beforeEach(() => {
  platform.tauri = false;
  platform.web = false;
  calls.length = 0;
  host = {
    settings: { ...DEFAULT_OPENCHRONICLE_SETTINGS },
    status: notInstalledStatus(),
    activityContext: HOST_ACTIVITY_CONTEXT,
    setEnabledResult: { ok: true },
  };
  vi.spyOn(ipcService, 'invokeDomain').mockImplementation(fakeInvokeDomain as typeof ipcService.invokeDomain);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  // jsdom 没有布局：NativeDesktopSection 挂载时会把选中的小时滚进视野
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.setState({ language: 'zh' });
});

afterAll(() => {
  if (process.env.SCREEN_MEMORY_CENSUS_OUT) fs.writeFileSync(process.env.SCREEN_MEMORY_CENSUS_OUT, JSON.stringify(census, null, 2));
});

describe('① Screen Memory page speaks plain words (real ScreenMemorySettings, desktop)', () => {
  const cases = (['zh', 'en'] as const).flatMap((lang) => [false, true].flatMap((tauri) => [false, true].map((installed) => ({ lang, tauri, installed }))));

  it.each(cases)('$lang · isTauriMode=$tauri · installed=$installed has no internal words in text/title/placeholder/aria-label', async ({ lang, tauri, installed }) => {
    platform.tauri = tauri;
    host.status = installed ? installedStatus() : notInstalledStatus();
    host.settings = { ...DEFAULT_OPENCHRONICLE_SETTINGS, enabled: installed };
    const { container } = await renderPage(lang);

    const strings = pageStrings(container);
    census.push({ scenario: `${lang} tauri=${tauri} installed=${installed}`, strings });
    expect(strings.length).toBeGreaterThan(20);
    expect(bannedHits(strings, lang === 'zh' ? ZH_BANNED : EN_BANNED)).toEqual([]);

    // 宿主 summary/detail 与宿主原始报错一律不上屏；pid 数字也不显示
    const all = strings.join('\n');
    for (const hostText of [HOST_TEXT.ocSummary, HOST_TEXT.ocDetail, HOST_TEXT.nativeSummary, HOST_TEXT.nativeDetail, HOST_TEXT.notInstalled, HOST_TEXT.unhealthy, ...HOST_UNAVAILABLE_REASONS]) {
      expect(all).not.toContain(hostText);
    }
    expect(all).not.toContain('4321');

    if (installed) {
      expect(all).toContain(COPY[lang].runError);
    } else {
      expect(all).toContain(COPY[lang].notInstalled);
    }
    // 英文界面在非 Tauri 桌面壳下整页只有本单的组件：不许漏出中文（名单输入框里是用户可改的默认值，不算界面文案）
    if (lang === 'en' && !tauri) {
      expect(pageStrings(container, { skipTextareaValues: true }).filter((text) => /[一-鿿]/.test(text))).toEqual([]);
    }
  });
});

describe('① preview with recorded content', () => {
  it('en names the source in English and shows no Chinese outside the editable lists', async () => {
    host.status = installedStatus();
    host.settings = { ...DEFAULT_OPENCHRONICLE_SETTINGS, enabled: true };
    host.activityContext = {
      ...HOST_ACTIVITY_CONTEXT,
      sources: [
        { source: 'openchronicle', status: 'available', confidence: 0.72, privacy: 'redacted', generatedAtMs: NOW, maxChars: 3000, text: 'Editing the weekly report in Word', evidenceRefs: [] },
        ...HOST_ACTIVITY_CONTEXT.sources.slice(1),
      ],
    };
    const { container } = await renderPage('en', 'Automatic: Editing the weekly report in Word');

    const strings = pageStrings(container, { skipTextareaValues: true });
    expect(strings.filter((text) => /[一-鿿]/.test(text))).toEqual([]);
    expect(bannedHits(strings, EN_BANNED)).toEqual([]);
  });
});

// 网页构建里设置页不显示屏幕记忆这一项（showScreenMemoryTab = isDesktopShellMode()），真页面到不了这个分支，
// 这里直接渲染它，核对网页分支的文案同样没有内部词、且不去问宿主。
describe('① web-mode branch of ScreenMemorySettings', () => {
  it.each(['zh', 'en'] as const)('%s shows the plain web explanation only', async (lang) => {
    platform.web = true;
    useAppStore.setState({ language: lang, cloudUIStrings: null });
    const { container } = render(<ScreenMemorySettings />);
    await waitFor(() => expect(container.textContent).toContain(COPY[lang].webBody), { timeout: WAIT_MS });

    const strings = pageStrings(container);
    census.push({ scenario: `${lang} web`, strings });
    expect(bannedHits(strings, lang === 'zh' ? ZH_BANNED : EN_BANNED)).toEqual([]);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('③ OpenChronicle not installed: one sentence, everything locked, no red box', () => {
  it.each(['zh', 'en'] as const)('%s', async (lang) => {
    host.status = notInstalledStatus();
    // 以前装过、开关存成了开：此时只有「没装」这一条能锁住勾选和名单
    host.settings = { ...DEFAULT_OPENCHRONICLE_SETTINGS, enabled: true };
    const { container } = await renderPage(lang);

    expect(screen.getByText(COPY[lang].notInstalled)).toBeTruthy();
    const toggle = screen.getByRole('switch', { name: COPY[lang].toggle }) as HTMLButtonElement;
    const checkbox = screen.getByRole('checkbox', { name: COPY[lang].autoInject }) as HTMLInputElement;
    const apps = screen.getByRole('textbox', { name: COPY[lang].apps }) as HTMLTextAreaElement;
    const sites = screen.getByRole('textbox', { name: COPY[lang].sites }) as HTMLTextAreaElement;
    expect([toggle.disabled, checkbox.disabled, apps.disabled, sites.disabled]).toEqual([true, true, true, true]);

    // lastError 有值也不出红框、不出失败句、不出宿主原文
    expect(container.querySelector('[class*="bg-red-900"]')).toBeNull();
    expect(container.textContent).not.toContain(COPY[lang].runError);
    expect(container.textContent).not.toContain(HOST_TEXT.notInstalled);
    // 顶部状态格也说「未安装」
    expect(screen.getAllByText(COPY[lang].tileNotInstalled).length).toBeGreaterThan(0);

    fireEvent.click(toggle);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter(([domain, action]) => domain === IPC_DOMAINS.OPENCHRONICLE && action === 'setEnabled')).toEqual([]);
  });
});

describe('③ after installing, Refresh unlocks the section and the page status follows', () => {
  it('zh: no 未安装 left anywhere once the host reports installed', async () => {
    host.status = notInstalledStatus();
    const { container } = await renderPage('zh');
    // 顶部状态格、自动屏幕记忆标题旁的状态徽标、开关区的运行状态格
    expect(screen.getAllByText(COPY.zh.tileNotInstalled)).toHaveLength(3);

    host.status = { installed: true, state: 'stopped', mcpHealthy: false, bufferFiles: 0, memoryEntries: 0 };
    const toggle = screen.getByRole('switch', { name: COPY.zh.toggle }) as HTMLButtonElement;
    fireEvent.click(within(toggle.closest('section')!).getByRole('button', { name: /刷新/ }));

    await waitFor(() => expect(toggle.disabled).toBe(false), { timeout: WAIT_MS });
    await waitFor(() => expect(screen.queryAllByText(COPY.zh.tileNotInstalled)).toEqual([]), { timeout: WAIT_MS });
    expect(container.textContent).not.toContain(COPY.zh.notInstalled);
    expect(calls.filter(([domain, action]) => domain === IPC_DOMAINS.ACTIVITY && action === 'listProviders')).toHaveLength(2);
  });
});

describe('④ Installed but start fails: locale sentence, raw host text stays out of the DOM', () => {
  it.each(['zh', 'en'] as const)('%s', async (lang) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    host.status = { installed: true, state: 'stopped', mcpHealthy: false, bufferFiles: 0, memoryEntries: 0 };
    host.settings = { ...DEFAULT_OPENCHRONICLE_SETTINGS, enabled: false };
    host.setEnabledResult = { ok: false, error: HOST_TEXT.cliMissing };
    host.statusAfterSetEnabled = { installed: true, state: 'error', mcpHealthy: false, bufferFiles: 0, memoryEntries: 0, lastError: HOST_TEXT.cliMissing };
    const { container } = await renderPage(lang);

    const toggle = screen.getByRole('switch', { name: COPY[lang].toggle }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(container.textContent).not.toContain(COPY[lang].notInstalled);
    fireEvent.click(toggle);

    await screen.findByText(COPY[lang].runError, {}, { timeout: WAIT_MS });
    expect(calls.filter(([domain, action]) => domain === IPC_DOMAINS.OPENCHRONICLE && action === 'setEnabled')).toEqual([
      [IPC_DOMAINS.OPENCHRONICLE, 'setEnabled', { enabled: true }],
    ]);
    expect(pageStrings(container).join('\n')).not.toContain(HOST_TEXT.cliMissing);
    // 原文只进日志
    expect(warn.mock.calls.some((args) => JSON.stringify(args).includes(HOST_TEXT.cliMissing))).toBe(true);
  });
});
