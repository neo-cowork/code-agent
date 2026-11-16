// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

import { ComputerUseContent } from '../../../src/renderer/components/features/computerUse/ComputerUseContent';
import { RouteTraceChip } from '../../../src/renderer/components/features/chat/RouteTraceChip';
import { setComputerUseSnapshot } from '../../../src/renderer/stores/computerUseStore';
import type { ComputerUseSnapshot } from '../../../src/renderer/stores/computerUseStore';

const BANNED = [/provider/i, /token/i, /AX candidates/i, /axPath/i];

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
    for (const word of BANNED) expect(before).not.toMatch(word);
    expect(screen.queryByTestId('computer-use-diagnostics')).toBeNull();

    fireEvent.click(screen.getByTestId('computer-use-diagnostics-toggle'));
    const panel = await screen.findByTestId('computer-use-diagnostics');
    await waitFor(() => expect(panel.textContent).toContain('window/0/button/1'));
    expect(panel.textContent).toMatch(/Native Desktop/);
    expect(panel.textContent).toMatch(/AX candidates|AX Tree/);
    expect(panel.textContent).toMatch(/Safari/);
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
    for (const word of [...BANNED, /endpoint/i, /stream-json/i, /MCP bridge/i]) {
      expect(before).not.toMatch(word);
    }
    expect(screen.queryByTestId('route-trace-diagnostics')).toBeNull();

    fireEvent.click(screen.getByTestId('route-trace-diagnostics-toggle'));
    const panel = screen.getByTestId('route-trace-diagnostics');
    expect(panel.textContent).toMatch(/provider/i);
    expect(panel.textContent).toMatch(/token/i);
    expect(panel.textContent).toMatch(/endpoint/i);
    expect(panel.textContent).toMatch(/stream-json/i);
  });
});
