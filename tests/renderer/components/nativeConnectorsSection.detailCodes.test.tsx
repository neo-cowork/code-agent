// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatusSummary, NativeConnectorDetailCode, NativeConnectorInventoryItem } from '../../../src/shared/ipc';
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

const CJK = /[㐀-鿿]/;
// Record<NativeConnectorDetailCode, …> in the catalogue makes the key list exhaustive at typecheck time.
const ALL_CODES = Object.keys(en.settings.nativeConnectors.grid.detailCode) as NativeConnectorDetailCode[];
const HOST_PROSE = '宿主写的中文句子 Command failed: osascript /Users/someone/x';

async function renderCalendarRow(language: 'zh' | 'en', detailCode: NativeConnectorDetailCode) {
  testLocale.value = language;
  const inventory: NativeConnectorInventoryItem[] = [{ id: 'calendar', label: 'Calendar', enabled: true }];
  const status: ConnectorStatusSummary = {
    id: 'calendar', label: 'Calendar', connected: false, readiness: 'unchecked',
    detailCode, detail: HOST_PROSE, error: HOST_PROSE, capabilities: ['list_events'], actions: ['repair_permissions'],
  };
  mockInvokeDomain.mockImplementation(async (_domain: string, action: string) => {
    if (action === 'listNativeInventory') return inventory;
    if (action === 'listStatuses') return [status];
  });
  render(React.createElement(NativeConnectorsSection, { presentation: 'grid' }));
  return screen.findByTestId('native-connector-card-calendar');
}

describe('NativeConnectorsSection renders every detailCode from the catalogue only', () => {
  afterEach(() => {
    cleanup();
    mockInvokeDomain.mockReset();
    testLocale.value = 'zh';
  });

  it('covers the whole code union in both languages', () => {
    expect(ALL_CODES.length).toBeGreaterThanOrEqual(15);
    expect(Object.keys(zh.settings.nativeConnectors.grid.detailCode).sort()).toEqual([...ALL_CODES].sort());
  });

  it.each(ALL_CODES)('en: %s is non-empty English with no CJK, no id: and no host prose', async (code) => {
    const card = await renderCalendarRow('en', code);
    const sentence = card.querySelector('p')?.textContent ?? '';
    expect(sentence.length).toBeGreaterThan(0);
    expect(card.textContent).not.toMatch(CJK);
    expect(card.textContent).not.toMatch(/id:|\{name\}|osascript|Command failed|\/Users\/|TCC|connector/i);
    expect(sentence).toBe(en.settings.nativeConnectors.grid.detailCode[code].replaceAll('{name}', en.settings.nativeConnectors.grid.labels.calendar));
  });

  it.each(ALL_CODES)('zh: %s is a non-empty Chinese sentence with no host prose', async (code) => {
    const card = await renderCalendarRow('zh', code);
    const sentence = card.querySelector('p')?.textContent ?? '';
    expect(sentence.length).toBeGreaterThan(0);
    expect(sentence).toMatch(CJK);
    expect(card.textContent).not.toMatch(/id:|\{name\}|宿主写的|osascript|Command failed|\/Users\/|TCC/);
  });
});
