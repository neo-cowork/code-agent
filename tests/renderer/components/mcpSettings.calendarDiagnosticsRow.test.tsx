// @vitest-environment jsdom
// Admin diagnostics path: real MCPSettings -> real NativeConnectorsSection -> real i18n catalogue.
import React from 'react';
import { cleanup, fireEvent, render, screen, within as within0 } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatusSummary, NativeConnectorInventoryItem } from '../../../src/shared/ipc';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const { mockInvokeDomain } = vi.hoisted(() => ({ mockInvokeDomain: vi.fn() }));

vi.mock('../../../src/renderer/hooks/useMcpStatus', () => ({
  useMcpStatus: () => ({ status: null, serverStates: [], isLoading: false, reload: vi.fn() }),
}));
vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({ items: [], skills: [], connectors: [], mcpServers: [] }),
}));
vi.mock('../../../src/renderer/hooks/useWorkbenchInsights', () => ({
  useWorkbenchInsights: () => ({
    capabilities: { skills: [], connectors: [], mcpServers: [] },
    invocationSummary: { skills: {}, connectors: {}, mcpServers: {} },
    references: [], history: [], connectorHistory: [], mcpHistory: [], skillHistory: [],
  }),
}));
vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner', () => ({
  useWorkbenchCapabilityQuickActionRunner: () => ({
    runningActionKey: null, actionErrors: {}, completedActions: {}, runQuickAction: vi.fn(),
  }),
}));
vi.mock('../../../src/renderer/hooks/useConnectorInChat', () => ({ useConnectorInChat: () => vi.fn() }));
vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain: mockInvokeDomain } }));
vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({ WebModeBanner: () => null }));
vi.mock('../../../src/renderer/components/features/settings/sections/localBridge', () => ({
  LocalBridgeSection: () => null,
}));
vi.mock('../../../src/renderer/components/features/settings/tabs/McpDiscoverTab', () => ({
  McpDiscoverTab: () => null,
}));
// NativeConnectorsSection stays real; only the unrelated SaaS card is stubbed.
vi.mock('../../../src/renderer/components/features/settings/sections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/components/features/settings/sections')>()),
  SaaSConnectorsSection: () => null,
}));

import { MCPSettings } from '../../../src/renderer/components/features/settings/tabs/MCPSettings';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const CJK = /[㐀-鿿]/;
const calendarInventory: NativeConnectorInventoryItem[] = [{ id: 'calendar', label: 'Calendar', enabled: true }];
const calendarStatus: ConnectorStatusSummary = {
  id: 'calendar', label: 'Calendar', connected: true, readiness: 'ready', detailCode: 'ready',
  capabilities: ['list_events'], actions: ['disconnect', 'remove'],
};

function setUser(isAdmin: boolean) {
  useAuthStore.setState({ user: { id: 'u1', email: 'a@example.test', isAdmin } } as never);
}

async function openDiagnosticsAndGetRow(language: 'en' | 'zh') {
  const copy = (language === 'en' ? en : zh).settings;
  const title = await screen.findByText(copy.mcp.diagnostics.title);
  const details = title.closest('details')!;
  fireEvent.click(title.closest('summary')!);
  details.open = true;
  const label = await within0(details).findByText(copy.nativeConnectors.grid.labels.calendar, { selector: 'span' });
  const row = label.closest('.rounded-md') as HTMLElement;
  expect(row).toBeTruthy();
  return { row, copy };
}

describe('MCPSettings admin diagnostics: calendar row (production entry)', () => {
  beforeEach(() => {
    mockInvokeDomain.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'listNativeInventory') return calendarInventory;
      if (action === 'listStatuses') return [calendarStatus];
      return { codex: {} };
    });
  });
  afterEach(() => {
    cleanup();
    mockInvokeDomain.mockReset();
  });

  it('en admin: calendar sentence is exactly "Calendar access allowed." with no CJK and no id:', async () => {
    setUser(true);
    useAppStore.setState({ language: 'en' });
    render(React.createElement(MCPSettings));
    const { row, copy } = await openDiagnosticsAndGetRow('en');
    const sentence = copy.nativeConnectors.grid.detailCode.ready.replaceAll('{name}', copy.nativeConnectors.grid.labels.calendar);
    const node = within(row, sentence);
    expect(node.textContent).toBe('Calendar access allowed.');
    expect(node.textContent).not.toMatch(CJK);
    expect(row.textContent).not.toMatch(/id:/i);
    console.log('EN row text:', JSON.stringify(row.textContent));
  });

  it('zh admin: calendar sentence is exactly "已允许访问日历。" with no id: and lists ASCII tokens', async () => {
    setUser(true);
    useAppStore.setState({ language: 'zh' });
    render(React.createElement(MCPSettings));
    const { row, copy } = await openDiagnosticsAndGetRow('zh');
    const sentence = copy.nativeConnectors.grid.detailCode.ready.replaceAll('{name}', copy.nativeConnectors.grid.labels.calendar);
    const node = within(row, sentence);
    expect(node.textContent).toBe('已允许访问日历。');
    expect(row.textContent).not.toMatch(/id:/i);
    const ascii = row.textContent!.match(/[A-Za-z][A-Za-z0-9._-]*/g) ?? [];
    console.log('ZH row text:', JSON.stringify(row.textContent));
    console.log('ZH ASCII tokens:', JSON.stringify(ascii));
    expect(ascii.filter((w) => !/^macOS$/.test(w))).toEqual([]);
  });

  it('non-admin: diagnostics section is absent (control for the isAdmin branch)', async () => {
    setUser(false);
    useAppStore.setState({ language: 'en' });
    render(React.createElement(MCPSettings));
    await screen.findByTestId('connector-grid');
    expect(screen.queryByText(en.settings.mcp.diagnostics.title)).toBeNull();
    expect(document.querySelector('details')?.textContent ?? '').not.toContain(en.settings.mcp.diagnostics.title);
  });
});

function within(row: HTMLElement, sentence: string): HTMLElement {
  const hits = Array.from(row.querySelectorAll<HTMLElement>('*')).filter(
    (el) => el.children.length === 0 && el.textContent === sentence,
  );
  expect(hits).toHaveLength(1);
  return hits[0];
}
