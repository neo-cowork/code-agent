// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatusSummary, NativeConnectorInventoryItem } from '../../../src/shared/ipc';
import { NATIVE_APP_NAMES } from '../../../src/host/connectors/native/appNames';
import { describeAppleScriptFailure } from '../../../src/host/connectors/native/appleScriptFailure';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const { mockInvokeDomain, testLocale } = vi.hoisted(() => ({
  mockInvokeDomain: vi.fn(),
  testLocale: { value: 'zh' as 'zh' | 'en' },
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: testLocale.value } }) }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => testLocale.value === 'zh' ? { t: zh, language: 'zh' } : { t: en, language: 'en' },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: mockInvokeDomain },
}));

import { NativeConnectorsSection } from '../../../src/renderer/components/features/settings/sections/NativeConnectorsSection';

describe('NativeConnectorsSection Automation denial card', () => {
  afterEach(() => {
    cleanup();
    mockInvokeDomain.mockReset();
    testLocale.value = 'zh';
  });

  it.each([
    ['mail', 'zh'],
    ['mail', 'en'],
    ['reminders', 'zh'],
    ['reminders', 'en'],
  ] as const)('shows %s Automation denial and the system settings button inside the %s card', async (id, locale) => {
    testLocale.value = locale;
    const copy = (locale === 'zh' ? zh : en).settings.nativeConnectors;
    const label = NATIVE_APP_NAMES[id].en;
    const raw = new Error(`Not authorized to send Apple events to ${label}. (-1743)`);
    const { message, code } = describeAppleScriptFailure(NATIVE_APP_NAMES[id], raw);
    expect(code).toBe('not_authorized');
    const inventory: NativeConnectorInventoryItem[] = [{ id, label, enabled: true }];
    const statuses: ConnectorStatusSummary[] = [{
      id, label, connected: false, readiness: 'failed', errorCode: 'not_authorized', error: message,
      capabilities: [], actions: ['repair_permissions'],
    }];
    mockInvokeDomain.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'listNativeInventory') return inventory;
      if (action === 'listStatuses') return statuses;
      if (action === 'openAutomationSettings') return { opened: true };
    });
    render(React.createElement(NativeConnectorsSection, { presentation: 'grid' }));

    const card = await screen.findByTestId(`native-connector-card-${id}`);
    expect(card.querySelector('p')?.textContent).toBe(message);
    expect(card.textContent).toContain(copy.readiness.failed);
    expect(card.textContent).not.toContain(copy.grid.statusDetail.failed);
    expect(screen.getAllByText(message, { exact: false })).toEqual([within(card).getByText(message)]);
    const button = within(card).getByRole('button', { name: copy.openAutomationSettings });
    fireEvent.click(button);
    const openCalls = mockInvokeDomain.mock.calls.filter(([, action]) => action === 'openAutomationSettings');
    expect(openCalls).toEqual([['domain:connector', 'openAutomationSettings']]);
    process.stdout.write(`${id}/${locale} card body: ${message}\n`);
    process.stdout.write(`${id}/${locale} settings IPC calls: ${JSON.stringify(openCalls)}\n`);
  });
});
