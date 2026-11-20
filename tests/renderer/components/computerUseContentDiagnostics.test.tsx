// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

// LocalOpsPage 入口挂载需要的两枚边缘 mock（与 localOpsPage.test.tsx 同写法）：
// cua-driver 已启用才渲染桌面 tab；浏览器 tab 的挂载面在桌面 tab 下不可见，stub 掉。
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [{ config: { name: 'cua-driver', enabled: true } }],
}));
vi.mock('../../../src/renderer/components/features/browser/BrowserSurfaceContent', () => ({
  BrowserSurfaceContent: () => <div data-testid="mock-browser-surface-content" />,
}));

import { listComputerSurfaceElements } from '../../../src/renderer/services/nativeDesktop';
import { ComputerUseContent } from '../../../src/renderer/components/features/computerUse/ComputerUseContent';
import { LocalOpsPage } from '../../../src/renderer/components/features/localOps/LocalOpsPage';
import { RouteTraceChip } from '../../../src/renderer/components/features/chat/RouteTraceChip';
import { setComputerUseSnapshot } from '../../../src/renderer/stores/computerUseStore';
import type { ComputerUseSnapshot } from '../../../src/renderer/stores/computerUseStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { localOpsEn, localOpsZh } from '../../../src/renderer/i18n/localOps';

const BANNED = [/provider/i, /token/i, /AX candidates/i, /axPath/i];
const BANNED_STATUS = [/Surface ready/i, /Approval scope/i, /Agent pointer/i, /current app/i];

function seedSnapshot(): void {
  setComputerUseSnapshot({
    capturedAtMs: Date.now(),
    nativeAvailable: true,
    capabilities: { platform: 'darwin', phase: 'phase-2', supportsFrontmostContext: true },
    permissionSnapshot: null,
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
      failureKind: 'locator_missing',
      blockingReasons: [],
      evidenceSummary: [],
      axQuality: null,
    },
    observation: null,
    desktopProviderError: 'Computer Surface state unavailable',
    observeError: null,
  } as unknown as ComputerUseSnapshot);
}

afterEach(() => {
  cleanup();
  setComputerUseSnapshot(null);
});

describe('ComputerUseContent diagnostics fold', () => {
  beforeEach(seedSnapshot);

  it('hides engineering words by default and reveals them behind the 诊断 toggle', async () => {
    render(<ComputerUseContent />);
    const root = screen.getByTestId('computer-use-content');
    await waitFor(() => expect(screen.getByTestId('computer-use-diagnostics-toggle')).toBeTruthy());

    const before = root.textContent ?? '';
    for (const word of [...BANNED, ...BANNED_STATUS]) expect(before).not.toMatch(word);
    expect(screen.queryByTestId('computer-use-diagnostics')).toBeNull();

    fireEvent.click(screen.getByTestId('computer-use-diagnostics-toggle'));
    const panel = await screen.findByTestId('computer-use-diagnostics');
    await waitFor(() => expect(panel.textContent).toContain('window/0/button/1'));
    expect(panel.textContent).toMatch(/Native Desktop/);
    expect(panel.textContent).toMatch(/AX candidates|AX Tree/);
    expect(panel.textContent).toMatch(/Safari/);
    expect(panel.textContent).toMatch(/Surface ready/);
    expect(panel.textContent).toMatch(/Approval scope/);
  });
});

describe('RouteTraceChip diagnostics fold', () => {
  const decision = {
    requestedProvider: 'claude_code',
    requestedModel: 'sonnet',
    resolvedProvider: 'claude_code',
    resolvedModel: 'sonnet',
    reason: 'user-selected',
    role: null,
    billingMode: 'payg',
    fallbackFrom: null,
    strategySummary: '本轮使用你选定的模型执行。',
    providerIdentity: {
      provider: 'claude_code',
      displayName: 'Claude Code',
      sourceLabel: 'Claude Code',
      protocol: 'openai',
      transportLabel: 'OpenAI-compatible',
      endpoint: 'https://relay.example/v1',
    },
    taskClass: 'coding',
    costPolicy: 'user-locked',
    speedPolicy: 'normal',
    toolPolicy: 'runtime-checked',
    toolStrategy: {
      visibleToolCount: 2,
      mcpToolCount: 1,
      mcpServerIds: ['github'],
      programmaticToolCalling: 'available',
      programmaticToolCount: 2,
      tokenSavings: {
        status: 'estimated',
        savedTokens: 128,
        detail: '估算值',
        measurement: {
          savingsSource: 'tool-spec-local-estimate',
          usageSource: 'model-response-usage',
          providerReportedSavings: false,
        },
      },
    },
    externalEngine: {
      kind: 'claude_code',
      label: 'Claude Code',
      model: 'sonnet',
      installState: 'installed',
      runtimeState: 'ready',
      executable: true,
      capabilities: ['execute'],
      reliability: {
        cliStatus: 'available',
        authState: 'needs_login',
        quotaState: 'not_checked',
        streamingMode: 'stream_json',
        toolSupport: 'read_only_cli_tools',
        transcriptMode: 'clean_stream_json',
        partialMessages: true,
        mcpBridge: false,
      },
      failure: {
        category: 'auth',
        reason: 'auth_failed',
        message: 'Failed to authenticate',
        suggestion: '登录已失效，请重新登录后重试。',
        retryable: false,
        occurredAt: Date.now(),
      },
    },
  } as unknown as React.ComponentProps<typeof RouteTraceChip>['decision'];

  it('keeps summary + suggestion visible, folds engineering rows behind the toggle', () => {
    render(<RouteTraceChip decision={decision} defaultExpanded />);
    const details = screen.getByTestId('route-trace-details');
    const before = details.textContent ?? '';
    expect(before).toContain('本轮使用你选定的模型执行。');
    expect(before).toContain('登录已失效，请重新登录后重试。');
    for (const word of [...BANNED, /endpoint/i, /地址/, /stream-json/i, /MCP bridge/i]) {
      expect(before).not.toMatch(word);
    }
    expect(screen.queryByTestId('route-trace-diagnostics')).toBeNull();

    fireEvent.click(screen.getByTestId('route-trace-diagnostics-toggle'));
    const panel = screen.getByTestId('route-trace-diagnostics');
    expect(panel.textContent).toMatch(/provider/i);
    expect(panel.textContent).toMatch(/token/i);
    expect(panel.textContent).toContain("地址 https://relay.example/v1");
    expect(panel.textContent).toMatch(/stream-json/i);
  });
});

// zh/en 双语桌面页诊断折叠证明（N-FIX-UI-RAW-TOOL-NAMES-EXPOSED-DIAG-FOLD-FU1）：
// 生产入口 = LocalOpsPage 桌面 tab（cua-driver enabled → 桌面 tab 渲染真实 ComputerUseContent）。
// listComputerSurfaceElements 返回 native bridge 的字段名（BackgroundAxElement: role/name/axPath）。
describe.each(['zh', 'en'] as const)(
  'LocalOpsPage desktop diagnostics fold (%s)',
  (language) => {
    const copy = (language === 'zh' ? localOpsZh : localOpsEn).localOps.computerUse;
    const diag = copy.diag;

    beforeEach(() => {
      useAppStore.getState().setLanguage(language);
      useAppStore.setState({ localOpsTab: 'desktop', showLocalOpsPanel: true });
      seedSnapshot();
      vi.mocked(listComputerSurfaceElements).mockResolvedValue({
        success: true,
        data: {
          metadata: {
            elementCount: 4,
            elements: [
              { index: 0, role: 'AXButton', name: 'Send', axPath: 'window/0/button/1', enabled: true },
              { index: 1, role: 'AXTextField', name: 'Message', axPath: 'window/0/textfield/2', enabled: true },
              { index: 2, role: 'AXStaticText', name: 'Status', enabled: true },
              { index: 3, role: 'AXCheckBox', name: 'Auto-start', enabled: false },
            ],
          },
        },
      } as unknown as Awaited<ReturnType<typeof listComputerSurfaceElements>>);
    });

    afterEach(() => {
      useAppStore.getState().setLanguage('zh');
      useAppStore.setState({ localOpsTab: 'desktop', showLocalOpsPanel: false });
    });

    it('collapsed default view shows no engineering words and the toggle label is localized', async () => {
      render(<LocalOpsPage />);
      const page = screen.getByTestId('local-ops-page');
      const toggle = await screen.findByTestId('computer-use-diagnostics-toggle');
      expect(toggle.textContent?.trim()).toBe(copy.diagnostics);
      expect(screen.queryByTestId('computer-use-diagnostics')).toBeNull();
      const before = page.textContent ?? '';
      for (const word of [...BANNED, ...BANNED_STATUS]) expect(before).not.toMatch(word);
    });

    it('expanding reveals each AX row as role/label/path cells; collapsing hides the paths again', async () => {
      render(<LocalOpsPage />);
      const page = screen.getByTestId('local-ops-page');
      fireEvent.click(await screen.findByTestId('computer-use-diagnostics-toggle'));
      const panel = await screen.findByTestId('computer-use-diagnostics');
      await within(panel).findByText('window/0/button/1');
      await within(panel).findByText('window/0/textfield/2');

      const expectRowCells = (thirdCell: string, role: string, label: string) => {
        const cell = within(panel).getByText(thirdCell);
        const row = cell.parentElement;
        expect(row?.childElementCount).toBe(3);
        expect(row?.children[0]?.textContent).toBe(role);
        expect(row?.children[1]?.textContent).toBe(label);
        expect(row?.children[2]?.textContent).toBe(thirdCell);
        expect(row?.children[2]).toBe(cell);
      };

      expectRowCells('window/0/button/1', 'AXButton', 'Send');
      expectRowCells('window/0/textfield/2', 'AXTextField', 'Message');
      expect(panel.textContent).toContain('window/0/button/1');
      expect(panel.textContent).toContain('window/0/textfield/2');

      // 无 axPath 行 / 禁用行：第三格回落到词条目录文案（不是字面量断言）
      expectRowCells(diag.noAxPath, 'AXStaticText', 'Status');
      expectRowCells(diag.disabled, 'AXCheckBox', 'Auto-start');

      fireEvent.click(screen.getByTestId('computer-use-diagnostics-toggle'));
      await waitFor(() => expect(screen.queryByTestId('computer-use-diagnostics')).toBeNull());
      const after = page.textContent ?? '';
      expect(after).not.toMatch(/axPath/i);
      expect(after).not.toContain('window/0/');
    });
  },
);
