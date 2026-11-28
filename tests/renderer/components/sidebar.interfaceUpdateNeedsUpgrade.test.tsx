// @vitest-environment jsdom
// 界面热更新因 app 太旧被拒时，侧栏「更新可用」入口多一行人话。渲染真实 Sidebar，只在 IPC 边界打桩。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RendererBundleLastAttemptStatus, RendererBundleStatus, UpdateInfo } from '../../../src/shared/contract';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const host = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  status: null as unknown,
  fail: false,
  reads: 0,
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: host.language === 'zh' ? zh : en, language: host.language }) };
});
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(async () => undefined),
    invokeDomain: vi.fn(async (domain: string, action: string) => {
      if (domain !== IPC_DOMAINS.UPDATE || action !== 'rendererBundleStatus') return [];
      host.reads += 1;
      if (host.fail) throw new Error('ipc unavailable');
      return host.status;
    }),
    on: () => () => {},
  },
}));

import { Sidebar } from '../../../src/renderer/components/Sidebar';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const CURRENT = '0.34.0';
const LINE = { zh: '升级后才能收到界面更新', en: 'Update to receive interface updates' } as const;
const ENTRY = { zh: '更新可用', en: 'Update available' } as const;
const CAPABILITY_ID = 'domain:update/rendererBundleStatus';

const offer: UpdateInfo = { hasUpdate: true, forceUpdate: false, currentVersion: CURRENT, latestVersion: '0.35.0' };

function bundleStatus(
  attempt: Partial<RendererBundleLastAttemptStatus>,
  extra: Partial<RendererBundleStatus> = {},
): RendererBundleStatus {
  return {
    schemaVersion: 1,
    activeBundle: null,
    lastAttempt: {
      checkedAt: '2026-11-27T00:00:00.000Z',
      manifestUrl: 'https://example.invalid/manifest.json',
      currentShellVersion: CURRENT,
      outcome: 'skipped',
      reason: 'shell-too-old',
      manifest: { version: '0.35.0', contentHash: 'h', minShellVersion: '0.35.0', requiredShellCapabilitiesCount: 0 },
      ...(attempt.reason === 'missing-shell-capability' ? { missingShellCapabilities: [CAPABILITY_ID] } : {}),
      ...attempt,
    },
    ...extra,
  };
}

async function mount(updateInfo: UpdateInfo | null = offer) {
  useAppStore.setState({ optionalUpdateInfo: updateInfo });
  const view = render(<Sidebar />);
  await act(async () => {});
  return view;
}

beforeEach(() => {
  host.status = bundleStatus({});
  host.fail = false;
  host.reads = 0;
  useAppStore.setState({ optionalUpdateInfo: null, showOptionalUpdateModal: false });
});
afterEach(cleanup);

describe.each(['zh', 'en'] as const)('侧栏更新入口的界面更新提示 (%s)', (language) => {
  beforeEach(() => { host.language = language; });

  it.each(['shell-too-old', 'missing-shell-capability'])('skipped/%s 时入口内多一行，不带内部名', async (reason) => {
    host.status = bundleStatus({ reason });
    const { container } = await mount();

    const line = screen.getByText(LINE[language]);
    const button = line.closest('button')!;
    expect(button.textContent).toContain(ENTRY[language]);
    expect(button.textContent).toContain('v0.35.0');
    expect(button.getAttribute('aria-describedby')).toBe(line.id);
    expect(container.textContent).not.toContain(CAPABILITY_ID);
    expect(container.textContent).not.toContain('rendererBundleStatus');

    fireEvent.click(line);
    expect(useAppStore.getState().showOptionalUpdateModal).toBe(true);
  });

  it.each<[string, RendererBundleStatus]>([
    ['applied', bundleStatus({ outcome: 'applied', reason: undefined })],
    ['already-current', bundleStatus({ reason: 'already-current' })],
    ['热更新被关掉', bundleStatus({}, { disabled: true, disabledReason: 'dev-slot' })],
    ['记录来自另一版 app', bundleStatus({ currentShellVersion: '0.33.0' })],
    ['还没有任何记录', { schemaVersion: 1, activeBundle: null, lastAttempt: null }],
  ])('%s：只有入口，没有这一行', async (_label, status) => {
    host.status = status;
    await mount();

    expect(host.reads).toBe(1);
    expect(screen.getByText(ENTRY[language])).toBeTruthy();
    expect(screen.queryByText(LINE[language])).toBeNull();
  });

  it('读状态报错：只有入口，没有这一行', async () => {
    host.fail = true;
    await mount();

    expect(host.reads).toBe(1);
    expect(screen.getByText(ENTRY[language])).toBeTruthy();
    expect(screen.queryByText(LINE[language])).toBeNull();
  });

  it.each<[string, UpdateInfo | null]>([
    ['没有更新信息', null],
    ['已是最新', { hasUpdate: false, currentVersion: CURRENT }],
  ])('%s：没有入口、没有这一行，也不去读状态', async (_label, updateInfo) => {
    await mount(updateInfo);

    expect(host.reads).toBe(0);
    expect(screen.queryByText(ENTRY[language])).toBeNull();
    expect(screen.queryByText(LINE[language])).toBeNull();
  });

  it('更新信息变了就重读一次；升级后入口和这一行一起消失', async () => {
    await mount();
    expect(screen.getByText(LINE[language])).toBeTruthy();

    host.status = bundleStatus({ outcome: 'applied', reason: undefined });
    await act(async () => { useAppStore.setState({ optionalUpdateInfo: { ...offer } }); });
    expect(host.reads).toBe(2);
    expect(screen.queryByText(LINE[language])).toBeNull();

    host.status = bundleStatus({});
    await act(async () => { useAppStore.setState({ optionalUpdateInfo: { ...offer } }); });
    expect(screen.getByText(LINE[language])).toBeTruthy();
    await act(async () => { useAppStore.setState({ optionalUpdateInfo: null }); });
    expect(screen.queryByText(ENTRY[language])).toBeNull();
    expect(screen.queryByText(LINE[language])).toBeNull();
  });
});
