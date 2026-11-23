// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatusSummary, NativeConnectorInventoryItem } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const { mockInvokeDomain } = vi.hoisted(() => ({ mockInvokeDomain: vi.fn() }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: mockInvokeDomain },
}));

import { NativeConnectorsSection } from '../../../src/renderer/components/features/settings/sections/NativeConnectorsSection';

const copy = zh.settings.nativeConnectors;
const inventory: NativeConnectorInventoryItem[] = [{ id: 'mail', label: 'Mail', enabled: true }];
const unchecked: ConnectorStatusSummary = {
  id: 'mail', label: 'Mail', connected: false, readiness: 'unchecked',
  capabilities: ['list_mail'], actions: ['repair_permissions'],
};
const denied = '邮件 未获授权：请在「系统设置」中允许 Neo。';
const deniedSentence = copy.grid.detailCode.automation_not_authorized.replaceAll('{name}', copy.grid.labels.mail);

function setup(
  reason: string,
  refreshedStatuses: ConnectorStatusSummary[],
  presentation: 'grid' | 'diagnostic' = 'grid',
) {
  let failed = false;
  let finishRefresh!: (statuses: ConnectorStatusSummary[]) => void;
  const pendingRefresh = new Promise<ConnectorStatusSummary[]>((resolve) => {
    finishRefresh = resolve;
  });
  mockInvokeDomain.mockImplementation(async (_domain: string, action: string) => {
    if (action === 'listNativeInventory') return inventory;
    if (action === 'listStatuses') return failed ? pendingRefresh : [unchecked];
    if (action === 'probe' || action === 'repairPermission') {
      failed = true;
      throw new Error(reason);
    }
  });
  render(React.createElement(NativeConnectorsSection, { presentation }));
  return () => act(async () => finishRefresh(refreshedStatuses));
}

describe('NativeConnectorsSection operation error', () => {
  afterEach(() => {
    cleanup();
    mockInvokeDomain.mockReset();
  });

  it.each([
    ['repair_permissions', 'repairPermission'],
    ['probe', 'probe'],
  ] as const)('shows only the card error after a denied %s', async (action, ipcAction) => {
    const refresh = setup(denied, [{
      ...unchecked, readiness: 'failed', errorCode: 'not_authorized', detailCode: 'automation_not_authorized',
    }]);
    const card = await screen.findByTestId('native-connector-card-mail');
    const grid = screen.getByTestId('native-connector-grid-items');
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: copy.actions[action].label })));
    expect(mockInvokeDomain).toHaveBeenCalledWith('domain:connector', ipcAction, { connectorId: 'mail' });
    expect(mockInvokeDomain.mock.calls.filter(([, name]) => name === 'listStatuses')).toHaveLength(2);
    expect(screen.queryByText(denied, { exact: false })).toBeNull();
    expect(Array.from(grid.children)).toEqual([card]);

    await refresh();

    expect(within(card).getByText(deniedSentence)).toBeTruthy();
    expect(within(card).getByRole('button', { name: copy.openAutomationSettings })).toBeTruthy();
    expect(screen.queryByText(denied, { exact: false })).toBeNull();
    expect(screen.getAllByText(deniedSentence, { exact: false })).toEqual([within(card).getByText(deniedSentence)]);
    expect(Array.from(grid.children)).toEqual([card]);
  });

  it('keeps the banner with no errorCode even if the failure text describes a denial', async () => {
    const refresh = setup(denied, [{ ...unchecked, readiness: 'failed', detailCode: 'probe_failed' }]);
    const card = await screen.findByTestId('native-connector-card-mail');
    fireEvent.click(within(card).getByRole('button', { name: copy.actions.probe.label }));
    await refresh();

    const banner = await screen.findByText(copy.operationFailedPrefix + denied);
    expect(card.contains(banner)).toBe(false);
    expect(within(card).getByText(copy.grid.detailCode.probe_failed.replaceAll('{name}', copy.grid.labels.mail))).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.openAutomationSettings })).toBeNull();
  });

  it('keeps the banner when only another connector has a denial code', async () => {
    const reason = '邮件响应超时，请稍后重试。';
    const refresh = setup(reason, [
      { ...unchecked, readiness: 'failed', detailCode: 'timeout' },
      { ...unchecked, id: 'reminders', readiness: 'failed', errorCode: 'not_authorized' },
    ]);
    const card = await screen.findByTestId('native-connector-card-mail');
    fireEvent.click(within(card).getByRole('button', { name: copy.actions.probe.label }));
    await refresh();

    const banner = await screen.findByText(copy.operationFailedPrefix + reason);
    expect(card.contains(banner)).toBe(false);
  });

  it('keeps the diagnostic banner and its settings action for a denial', async () => {
    const refresh = setup(denied, [{
      ...unchecked, readiness: 'failed', errorCode: 'not_authorized', detailCode: 'automation_not_authorized',
    }], 'diagnostic');
    fireEvent.click(await screen.findByRole('button', { name: copy.actions.probe.label }));
    await refresh();

    const banner = await screen.findByText(copy.operationFailedPrefix + denied);
    const settingsButton = within(banner.parentElement!).getByRole('button', { name: copy.openAutomationSettings });
    fireEvent.click(settingsButton);
    expect(mockInvokeDomain).toHaveBeenCalledWith('domain:connector', 'openAutomationSettings');
  });
});
