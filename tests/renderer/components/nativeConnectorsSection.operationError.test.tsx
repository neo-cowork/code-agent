// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatusSummary, NativeConnectorInventoryItem } from '../../../src/shared/ipc';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const { mockInvokeDomain, testLocale } = vi.hoisted(() => ({
  mockInvokeDomain: vi.fn(),
  testLocale: { value: 'zh' as 'zh' | 'en' },
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => testLocale.value === 'zh' ? { t: zh, language: 'zh' } : { t: en, language: 'en' },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: mockInvokeDomain },
}));

import { NativeConnectorsSection } from '../../../src/renderer/components/features/settings/sections/NativeConnectorsSection';

const inventory: NativeConnectorInventoryItem[] = [{ id: 'calendar', label: 'Calendar', enabled: true }];

function setup(failure: Error, errorCode?: 'not_authorized') {
  const statuses: ConnectorStatusSummary[] = [{
    id: 'calendar', label: 'Calendar', connected: false, readiness: 'failed', errorCode,
    capabilities: ['calendar_read'], actions: ['repair_permissions'],
  }];
  mockInvokeDomain.mockImplementation((_d: string, action: string) => {
    if (action === 'listNativeInventory') return Promise.resolve(inventory);
    if (action === 'listStatuses') return Promise.resolve(statuses);
    if (action === 'probe' || action === 'repairPermission') return Promise.reject(failure);
    if (action === 'openAutomationSettings') return Promise.resolve({ opened: true });
    return Promise.resolve(undefined);
  });
  render(React.createElement(NativeConnectorsSection, { presentation: 'grid' }));
}

async function clickCheck() {
  const card = await screen.findByTestId('native-connector-card-calendar');
  const buttons = card.querySelectorAll('button');
  fireEvent.click(buttons[buttons.length - 1]);
}

describe('NativeConnectorsSection operation error', () => {
  afterEach(() => {
    cleanup();
    mockInvokeDomain.mockReset();
    testLocale.value = 'zh';
  });

  it('not_authorized：显示 host 人话 + 「打开系统设置」，点击走 openAutomationSettings', async () => {
    setup(new Error('Calendar 未获授权：请在「系统设置」中允许 Neo。'), 'not_authorized');
    await clickCheck();
    const btn = await screen.findByRole('button', { name: zh.settings.nativeConnectors.openAutomationSettings });
    fireEvent.click(btn);
    expect(mockInvokeDomain).toHaveBeenCalledWith('domain:connector', 'openAutomationSettings');
  });

  it('没有 errorCode 时不显示打开系统设置按钮', async () => {
    setup(new Error('Calendar 响应超时，请稍后重试。'));
    await clickCheck();
    await screen.findByText(/响应超时/);
    expect(screen.queryByRole('button', { name: zh.settings.nativeConnectors.openAutomationSettings })).toBeNull();
  });
});
