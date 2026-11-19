// @vitest-environment jsdom
// N-FIX-CU-PAGE-PERMISSION-LABELS-NOT-LOCALIZED：Computer Use 页默认视图的权限名 / 徽章 /
// 状态 pill / 按钮文案全部走 i18n——zh 与 en 各自不出现对方的语言。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// 只 mock 桥接边缘（native desktop 服务），组件本体真渲染。
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  getFrontmostDesktopContext: vi.fn(async () => null),
  getNativeDesktopCapabilities: vi.fn(async () => null),
  getNativeDesktopCollectorStatus: vi.fn(async () => null),
  getNativeDesktopPermissionStatus: vi.fn(async () => null),
  isNativeDesktopAvailable: vi.fn(() => true),
  listComputerSurfaceElements: vi.fn(async () => ({
    success: true,
    data: {
      metadata: {
        elementCount: 1,
        elements: [{ role: 'AXButton', name: 'Send', axPath: 'window/0/button/1', enabled: true }],
      },
    },
  })),
  listRecentNativeDesktopEvents: vi.fn(async () => []),
  observeComputerSurface: vi.fn(async () => ({ success: false })),
  openNativeDesktopSystemSettings: vi.fn(async () => undefined),
  readComputerSurfaceState: vi.fn(async () => ({ success: false })),
}));

import { isNativeDesktopAvailable } from '../../../src/renderer/services/nativeDesktop';
import { ComputerUseContent } from '../../../src/renderer/components/features/computerUse/ComputerUseContent';
import { setComputerUseSnapshot } from '../../../src/renderer/stores/computerUseStore';
import type { ComputerUseSnapshot } from '../../../src/renderer/stores/computerUseStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { localOpsEn, localOpsZh } from '../../../src/renderer/i18n/localOps';

// 与 renderer-cjk-literal-ratchet.mjs 的 HAN_RE 同口径
const CJK = /[㐀-䶿一-鿿豈-﫿]/u;
const ENGLISH_PERMISSION_NAMES = /Accessibility|Screen Recording|Automation/;
const NATIVE_DETAIL = 'AXIsProcessTrusted() returned false. Enable in System Settings';

function seedPermissionSnapshot(statuses: { accessibility: string; screenCapture: string }): void {
  setComputerUseSnapshot({
    capturedAtMs: Date.now(),
    nativeAvailable: true,
    capabilities: { platform: 'darwin', phase: 'phase-2', supportsFrontmostContext: true },
    permissionSnapshot: {
      schemaVersion: 1,
      platform: 'darwin',
      checkedAtMs: Date.now(),
      bundleId: 'com.linchen.code-agent.dev',
      permissions: [
        {
          kind: 'accessibility',
          label: 'Accessibility',
          status: statuses.accessibility,
          required: true,
          detail: NATIVE_DETAIL,
        },
        {
          kind: 'screenCapture',
          label: 'Screen Recording',
          status: statuses.screenCapture,
          required: false,
          detail: 'Screen Capture permission not granted.',
        },
      ],
      summary: { granted: 0, denied: 2, needsRestart: 0, wrongBundleId: 0, unknown: 0, unsupported: 0 },
    },
    collectorStatus: { running: true },
    frontmost: { appName: 'Safari', windowTitle: 'Home', capturedAtMs: Date.now() },
    recentEvents: [],
    surface: {
      id: 's1',
      mode: 'background_ax',
      platform: 'darwin',
      ready: true,
      background: true,
      approvalScope: 'approved',
      targetApp: 'Safari',
      approvedApps: [],
      deniedApps: [],
      lastAction: null,
      lastSnapshot: null,
      failureKind: null,
      blockingReasons: [],
      evidenceSummary: [],
      axQuality: null,
    },
    observation: null,
    desktopProviderError: null,
    observeError: null,
  } as unknown as ComputerUseSnapshot);
}

async function renderDefaultView(): Promise<string> {
  render(<ComputerUseContent />);
  const root = screen.getByTestId('computer-use-content');
  await waitFor(() => expect(root.textContent).toContain(useAppStore.getState().language === 'en' ? 'Permissions' : '权限'));
  // 断言范围 = 默认视图：诊断折叠区保持关闭
  expect(screen.queryByTestId('computer-use-diagnostics')).toBeNull();
  return root.textContent ?? '';
}

beforeEach(() => {
  useAppStore.getState().setLanguage('zh');
  vi.mocked(isNativeDesktopAvailable).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  setComputerUseSnapshot(null);
  useAppStore.getState().setLanguage('zh');
});

describe('ComputerUseContent 权限文案 i18n（zh）', () => {
  it('权限卡：辅助功能/必需、屏幕录制/可选、自动化 + 按 app 单独授权，pill 与按钮同语言', async () => {
    seedPermissionSnapshot({ accessibility: 'denied', screenCapture: 'denied' });
    const text = await renderDefaultView();

    expect(text).toContain('辅助功能');
    expect(text).toContain('必需');
    expect(text).toContain('屏幕录制');
    expect(text).toContain('可选');
    expect(text).toContain('自动化');
    expect(text).toContain('按 app 单独授权');
    expect(text).toContain('开启辅助功能权限');
    expect(text).toContain('开启录屏（可选）');
    // denied → pill「未授权」；屏幕录制未授权 → pill 回落「可选」
    expect(text).toContain('未授权');
    // 英文系统权限名不得出现在 zh 默认视图
    expect(text).not.toMatch(ENGLISH_PERMISSION_NAMES);
  });

  it('授权后：pill 变「已授权」，开启按钮消失', async () => {
    seedPermissionSnapshot({ accessibility: 'granted', screenCapture: 'granted' });
    const text = await renderDefaultView();

    expect(text).toContain('已授权');
    expect(text).not.toContain('开启辅助功能权限');
    expect(text).not.toContain('开启录屏（可选）');
    expect(text).not.toMatch(ENGLISH_PERMISSION_NAMES);
  });

  it('原生英文 detail 不上默认卡：一律本地化提示', async () => {
    seedPermissionSnapshot({ accessibility: 'denied', screenCapture: 'denied' });
    const text = await renderDefaultView();

    expect(text).not.toContain('AXIsProcessTrusted');
    expect(text).not.toContain('Screen Capture permission not granted.');
    expect(text).toContain(localOpsZh.localOps.computerUse.accessibilityHint);
  });

  it('失败卡走 i18n：zh 卡标题用中文权限名', async () => {
    seedPermissionSnapshot({ accessibility: 'denied', screenCapture: 'denied' });
    const text = await renderDefaultView();

    expect(text).toContain('辅助功能未授权');
    expect(text).toContain('屏幕录制可选');
    expect(text).toContain('自动化是按目标 app 授权');
    expect(text).not.toMatch(ENGLISH_PERMISSION_NAMES);
  });

  it('网页降级（nativeAvailable=false、permissionSnapshot=null）：默认视图仍是纯中文', async () => {
    vi.mocked(isNativeDesktopAvailable).mockReturnValue(false);
    setComputerUseSnapshot(null);
    const text = await renderDefaultView();

    expect(text).toContain('当前是网页版');
    expect(text).toContain('网页版里无法读取桌面状态');
    expect(text).not.toMatch(ENGLISH_PERMISSION_NAMES);
  });
});

describe('ComputerUseContent permission copy i18n (en)', () => {
  it('permission cards show Accessibility/Required, Screen Recording/Optional, Automation + Per-app approval', async () => {
    useAppStore.getState().setLanguage('en');
    seedPermissionSnapshot({ accessibility: 'denied', screenCapture: 'denied' });
    const text = await renderDefaultView();

    expect(text).toContain('Accessibility');
    expect(text).toContain('Required');
    expect(text).toContain('Screen Recording');
    expect(text).toContain('Optional');
    expect(text).toContain('Automation');
    expect(text).toContain('Per-app approval');
    expect(text).toContain('Enable Accessibility');
    expect(text).toContain('Enable Screen Recording (optional)');
    expect(text).toContain('Not granted');
    // en 默认视图不得混入任何 CJK
    expect(text).not.toMatch(CJK);
  });

  it('granted pills read Granted and the enable buttons disappear', async () => {
    useAppStore.getState().setLanguage('en');
    seedPermissionSnapshot({ accessibility: 'granted', screenCapture: 'granted' });
    const text = await renderDefaultView();

    expect(text).toContain('Granted');
    expect(text).not.toContain('Enable Accessibility');
    expect(text).not.toMatch(CJK);
  });

  it('failure cards come from the en copy, native detail stays off the default view', async () => {
    useAppStore.getState().setLanguage('en');
    seedPermissionSnapshot({ accessibility: 'denied', screenCapture: 'denied' });
    const text = await renderDefaultView();

    // 失败卡标题由 getPermissionCopy 的名字拼出——权限名走 i18n 才能得到这两句
    expect(text).toContain('Accessibility not granted');
    expect(text).toContain('Screen Recording is optional');
    expect(text).toContain('Automation is granted per app');
    expect(text).not.toContain('AXIsProcessTrusted');
    expect(text).toContain(localOpsEn.localOps.computerUse.accessibilityHint);
    expect(text).not.toMatch(CJK);
  });

  it('web fallback (nativeAvailable=false, permissionSnapshot=null): default view stays English-only', async () => {
    useAppStore.getState().setLanguage('en');
    vi.mocked(isNativeDesktopAvailable).mockReturnValue(false);
    setComputerUseSnapshot(null);
    const text = await renderDefaultView();

    expect(text).toContain('You are in the web build');
    expect(text).toContain('Desktop state is not readable in the web build');
    expect(text).not.toMatch(CJK);
  });
});
