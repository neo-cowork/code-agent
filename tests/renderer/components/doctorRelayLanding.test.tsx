// @vitest-environment jsdom
// Doctor「浏览器 Relay」修复按钮落点：点完后真实渲染本机操作页，必须能看到「启动 Relay」。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../../src/renderer/components/features/computerUse/ComputerUseContent', () => ({
  ComputerUseContent: () => <div />,
}));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({ useMcpServerStates: () => [] }));
vi.mock('../../../src/renderer/hooks/useLiveAgentPointer', () => ({
  useLiveAgentPointer: () => ({ event: null, lastEvent: null, isLive: false, timeline: [] }),
}));
vi.mock('../../../src/renderer/hooks/useWorkbenchBrowserSession', () => ({
  useWorkbenchBrowserSession: () => ({
    mode: 'managed',
    managedSession: {
      running: false,
      externalBridge: { status: 'stopped', port: null, tokenHint: null, extensionPath: '/x', attachedTabCount: 0 },
    },
    preview: null,
    refresh: async () => {},
  }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn(async () => ({})) },
}));

import { LocalOpsPage } from '../../../src/renderer/components/features/localOps/LocalOpsPage';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { runDoctorFix } from '../../../src/renderer/utils/doctorFixActions';
import { DOCTOR_FIX_CODES } from '../../../src/shared/constants/doctor';

beforeEach(() => {
  useAppStore.setState({ showSettings: true, showLocalOpsPanel: false, localOpsTab: 'desktop' });
});
afterEach(() => cleanup());

describe('Doctor relay 修复落点', () => {
  it('落到本机操作页，显示 Chrome Relay 状态「未启动」与「启动 Relay」按钮', async () => {
    await runDoctorFix(DOCTOR_FIX_CODES.OPEN_BROWSER_RELAY_SETTINGS);
    expect(useAppStore.getState().showSettings).toBe(false);
    render(<LocalOpsPage />);
    expect(screen.getByText('Chrome Relay')).toBeTruthy();
    expect(screen.getByText('启动 Relay')).toBeTruthy();
    expect(screen.getAllByText('未启动').length).toBeGreaterThan(0);
  });
});
