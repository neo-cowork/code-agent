// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatusSummary, NativeConnectorInventoryItem } from '../../../src/shared/ipc';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const { mockInvokeDomain, testLocale } = vi.hoisted(() => ({
  mockInvokeDomain: vi.fn(),
  testLocale: { value: 'zh' as 'zh' | 'en' },
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => testLocale.value === 'zh'
    ? { t: zh, language: 'zh' }
    : { t: en, language: 'en' },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: mockInvokeDomain },
}));

import { NativeConnectorsSection } from '../../../src/renderer/components/features/settings/sections/NativeConnectorsSection';

const inventory: NativeConnectorInventoryItem[] = [
  { id: 'calendar', label: '日历', enabled: true },
  { id: 'mail', label: '邮件', enabled: true },
  { id: 'photos', label: '照片', enabled: false },
  { id: 'reminders', label: '提醒事项', enabled: true },
];

const statuses: ConnectorStatusSummary[] = inventory.map((item) => ({
  id: item.id,
  label: item.label,
  connected: item.enabled,
  readiness: item.enabled ? 'ready' : 'unchecked',
  capabilities: [`${item.id}_read`],
}));

const readinessValues = ['ready', 'unchecked', 'failed', 'unavailable'] as const;
const hostStatusDetails: Record<(typeof readinessValues)[number], string> = {
  ready: 'Calendar connector 已通过本地授权/可用性检查。',
  unchecked: 'Calendar connector 已启用，但还未检查本地授权；点“检查/授权”时才会拉起 Calendar 或触发系统授权。',
  failed: 'Calendar 授权/可用性检查失败：Automation denied',
  unavailable: 'Calendar connector 仅在 macOS 可用。',
};

describe('NativeConnectorsSection grid presentation', () => {
  afterEach(() => {
    cleanup();
    mockInvokeDomain.mockReset();
    testLocale.value = 'zh';
  });

  it('shows all four native connectors as ordinary-user cards without runtime diagnostics', async () => {
    mockInvokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'listNativeInventory') return Promise.resolve(inventory);
      if (action === 'listStatuses') return Promise.resolve(statuses);
      return Promise.resolve(undefined);
    });

    render(React.createElement(NativeConnectorsSection, { presentation: 'grid' }));

    for (const item of inventory) {
      expect(await screen.findByTestId(`native-connector-card-${item.id}`)).toBeTruthy();
    }
    expect(screen.getByText(zh.settings.nativeConnectors.grid.labels.calendar)).toBeTruthy();
    expect(screen.getByText(zh.settings.nativeConnectors.grid.descriptions.photos)).toBeTruthy();
    expect(screen.getAllByRole('switch')).toHaveLength(4);
    expect(screen.queryByText(zh.settings.nativeConnectors.otherConnectors)).toBeNull();
  });

  for (const language of ['zh', 'en'] as const) {
    for (const readiness of readinessValues) {
      it(`localizes ${readiness} host status detail in ${language}`, async () => {
        testLocale.value = language;
        const text = language === 'zh' ? zh : en;
        const statusesWithHostDetail = statuses.map((status) => status.id === 'calendar'
          ? {
              ...status,
              readiness,
              detail: hostStatusDetails[readiness],
              error: readiness === 'failed' ? 'Automation denied' : undefined,
            }
          : status);
        mockInvokeDomain.mockImplementation((_domain: string, action: string) => {
          if (action === 'listNativeInventory') return Promise.resolve(inventory);
          if (action === 'listStatuses') return Promise.resolve(statusesWithHostDetail);
          return Promise.resolve(undefined);
        });

        render(React.createElement(NativeConnectorsSection, { presentation: 'grid' }));

        const card = await screen.findByTestId('native-connector-card-calendar');
        expect(card.querySelector('p')?.textContent).toBe(text.settings.nativeConnectors.grid.statusDetail[readiness]);
        expect(card.textContent).not.toContain(hostStatusDetails[readiness]);
        expect(card.textContent).not.toContain('Automation denied');
        if (language === 'zh') {
          expect(card.textContent).not.toContain('connector');
        } else {
          expect(card.textContent).not.toMatch(/[一-鿿]/);
        }
      });
    }
  }
});
