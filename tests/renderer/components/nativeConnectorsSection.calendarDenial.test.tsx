// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const zhCodes = zh.settings.nativeConnectors.grid.detailCode;
const enCodes = en.settings.nativeConnectors.grid.detailCode;
const DENIED_DETAIL = zhCodes.calendar_denied;
const UNDECIDED_DETAIL = zhCodes.calendar_undecided;
const CJK = /[\u3400-\u9fff]/;

const inventory: NativeConnectorInventoryItem[] = [{ id: 'calendar', label: 'Calendar', enabled: true }];

function status(overrides: Partial<ConnectorStatusSummary>): ConnectorStatusSummary {
  return {
    id: 'calendar',
    label: 'Calendar',
    connected: false,
    readiness: 'unchecked',
    capabilities: ['list_events'],
    actions: ['repair_permissions', 'disconnect', 'remove'],
    ...overrides,
  };
}

function mount(next: ConnectorStatusSummary) {
  mockInvokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'listNativeInventory') return Promise.resolve(inventory);
    if (action === 'listStatuses') return Promise.resolve([next]);
    if (action === 'openCalendarSettings') return Promise.resolve({ opened: true });
    return Promise.resolve(undefined);
  });
  render(React.createElement(NativeConnectorsSection, { presentation: 'grid' }));
}

describe('NativeConnectorsSection calendar denial card', () => {
  afterEach(() => {
    cleanup();
    mockInvokeDomain.mockReset();
    testLocale.value = 'zh';
  });

  it('shows the denied sentence and opens Calendar settings from the card button', async () => {
    mount(status({ detailCode: 'calendar_denied', checkedAt: 1_700_000_000_000, settingsPane: 'calendars' }));
    const card = await screen.findByTestId('native-connector-card-calendar');
    expect(card.querySelector('p')?.textContent).toBe(DENIED_DETAIL);
    expect(card.textContent).not.toContain(zh.settings.nativeConnectors.grid.statusDetail.unchecked);
    const button = screen.getByRole('button', { name: zh.settings.nativeConnectors.openAutomationSettings });
    fireEvent.click(button);
    expect(mockInvokeDomain).toHaveBeenCalledWith('domain:connector', 'openCalendarSettings');
    expect(mockInvokeDomain).not.toHaveBeenCalledWith('domain:connector', 'openAutomationSettings');
    expect(card.textContent).not.toMatch(/osascript|Command failed|\/v1\/|EKAuthorization|settingsPane|not_authorized|write_only|\b(denied|undecided|granted|calendars|automation)\b/);
    process.stdout.write(`④ denied card: ${card.textContent}\n`);
  });

  it('after Check, an undecided calendar shows its sentence and no settings button', async () => {
    mount(status({ detailCode: 'calendar_undecided', checkedAt: 1_700_000_000_000 }));
    const card = await screen.findByTestId('native-connector-card-calendar');
    expect(card.querySelector('p')?.textContent).toBe(UNDECIDED_DETAIL);
    expect(screen.queryByRole('button', { name: zh.settings.nativeConnectors.openAutomationSettings })).toBeNull();
    expect(card.textContent).not.toMatch(/osascript|Command failed|\/v1\/|EKAuthorization|settingsPane|not_authorized|\b(denied|undecided|granted|calendars|automation)\b/);
    process.stdout.write(`④ undecided-after-Check card: ${card.textContent}\n`);
  });

  it('shows the enabled-not-checked catalogue sentence before any check, never host prose', async () => {
    mount(status({ detailCode: 'unchecked', detail: '宿主写的中文句子，不该出现' }));
    const card = await screen.findByTestId('native-connector-card-calendar');
    expect(card.querySelector('p')?.textContent).toBe(zhCodes.unchecked.replace('{name}', zh.settings.nativeConnectors.grid.labels.calendar));
    expect(card.textContent).not.toContain('宿主写的中文句子');
  });

  it('shows no sentence from host prose when the status has no code', async () => {
    mount(status({ detail: '宿主写的中文句子，不该出现', error: 'Command failed: osascript' }));
    const card = await screen.findByTestId('native-connector-card-calendar');
    expect(card.querySelector('p')?.textContent).toBe(zh.settings.nativeConnectors.grid.statusDetail.unchecked);
    expect(card.textContent).not.toMatch(/宿主写的|osascript|Command failed/);
  });

  it('uses the English button label and the English sentence on an English card', async () => {
    testLocale.value = 'en';
    mount(status({ detailCode: 'calendar_denied', checkedAt: 1_700_000_000_000, settingsPane: 'calendars' }));
    const card = await screen.findByTestId('native-connector-card-calendar');
    expect(card.querySelector('p')?.textContent).toBe(enCodes.calendar_denied);
    expect(card.textContent).not.toMatch(CJK);
    expect(screen.getByRole('button', { name: en.settings.nativeConnectors.openAutomationSettings })).toBeTruthy();
    process.stdout.write(`④ en denied card: ${card.textContent}\n`);
  });
});
