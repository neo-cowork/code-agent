// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mcpRuntime = vi.hoisted(() => ({ present: true }));

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: () => Promise.resolve([]),
    getStats: () => Promise.resolve(null),
    getExecutions: () => Promise.resolve([]),
  },
}));
vi.mock('../../../src/renderer/components/features/computerUse/ComputerUseContent', () => ({
  ComputerUseContent: () => <div data-testid="mock-computer-use-content" />,
}));
vi.mock('../../../src/renderer/components/features/browser/BrowserSurfaceContent', () => ({
  BrowserSurfaceContent: () => <div data-testid="mock-browser-surface-content" />,
}));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => mcpRuntime.present
    ? [{ config: { name: 'cua-driver', enabled: true } }]
    : [],
}));

import { SidebarCapabilityZone } from '../../../src/renderer/components/features/sidebar/SidebarCapabilityZone';
import { LocalOpsPage } from '../../../src/renderer/components/features/localOps/LocalOpsPage';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

function resetState() {
  mcpRuntime.present = true;
  useAuthStore.setState({ isAuthenticated: false, user: null });
  useAppStore.setState({ showLocalOpsPanel: false, localOpsTab: 'browser', language: 'zh' });
}

beforeEach(resetState);
afterEach(() => { cleanup(); resetState(); });

describe('侧栏「本机操作」入口（未登录可达）', () => {
  it('未登录时侧栏有本机操作行，点击打开 LocalOps 桌面 tab', () => {
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    render(<SidebarCapabilityZone />);
    const row = screen.getByTestId('sidebar-capability-local-ops');
    expect(row.textContent).toContain('本机操作');
    expect(row.getAttribute('title')).toBe('电脑操作与授权 · 浏览器');
    fireEvent.click(row);
    expect(useAppStore.getState()).toMatchObject({ showLocalOpsPanel: true, localOpsTab: 'desktop' });
  });

  it('cua-driver 已启用时点击入口后页面落在桌面 tab', () => {
    render(<SidebarCapabilityZone />);
    fireEvent.click(screen.getByTestId('sidebar-capability-local-ops'));
    cleanup();
    render(<LocalOpsPage />);
    expect(screen.getByTestId('local-ops-tab-desktop').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('mock-computer-use-content')).toBeTruthy();
  });

  it('没有 cua-driver 时降级到浏览器 tab，不崩溃', () => {
    mcpRuntime.present = false;
    render(<SidebarCapabilityZone />);
    fireEvent.click(screen.getByTestId('sidebar-capability-local-ops'));
    cleanup();
    render(<LocalOpsPage />);
    expect(screen.queryByTestId('local-ops-tab-desktop')).toBeNull();
    expect(screen.getByTestId('mock-browser-surface-content')).toBeTruthy();
  });
});
