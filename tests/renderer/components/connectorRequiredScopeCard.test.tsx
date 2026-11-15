// @vitest-environment jsdom
// N-CONNECTOR-POLISH-AUDIT-FU4-SCOPE：insufficient_scope 连接卡（重新授权按钮 / 可选链接 / 不被 watcher 自动消掉）
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_REQUIRED_POLL } from '../../../src/shared/constants';

const ipcMock = vi.hoisted(() => ({
  reauthorize: vi.fn(),
  invokeDomain: vi.fn(),
  on: vi.fn(() => () => undefined),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: ipcMock.invokeDomain, on: ipcMock.on },
}));

import { ConnectorRequiredCards } from '../../../src/renderer/components/features/chat/connectorRequiredCard';
import { parseConnectorRequiredPayload, useConnectorRequiredStore } from '../../../src/renderer/stores/connectorRequiredStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { startConnectorRequiredWatcher } from '../../../src/renderer/utils/connectorRequiredWatcher';

const sendPrompt = vi.fn(async () => undefined);
const scopeItem = { id: 'notion', source: 'selected' as const, reason: 'insufficient_scope', requiredScope: 'write' };

describe('insufficient_scope connector card', () => {
  beforeEach(() => {
    ipcMock.reauthorize.mockReset();
    ipcMock.invokeDomain.mockReset();
    ipcMock.invokeDomain.mockImplementation(async (domain: string, method: string, payload: unknown) => {
      if (method === 'reauthorizeServer') return ipcMock.reauthorize(domain, payload);
      return method === 'oauthStatus' ? [{ id: 'notion', connected: true }] : [];
    });
    sendPrompt.mockClear();
    useConnectorRequiredStore.setState({ entries: {} });
    useAppStore.setState({ language: 'zh' } as never);
    useMessageActionStore.setState({ _send: vi.fn(), sendPrompt } as never);
    useSessionStore.setState({ currentSessionId: 's1', runningSessionIds: new Set() });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('shows 重新授权 and no permission link when helpUrl is absent', () => {
    useConnectorRequiredStore.getState().report('s1', [scopeItem]);
    render(<ConnectorRequiredCards />);
    expect(screen.getByTestId('connector-required-card-notion').textContent).toContain('当前的授权缺少这次操作需要的权限');
    expect(screen.getByTestId('connector-required-reauthorize').textContent).toBe('重新授权');
    expect(screen.queryByTestId('connector-required-help-link')).toBeNull();
  });

  it('shows the permission link only when helpUrl is present, alongside 重新授权', () => {
    useConnectorRequiredStore.getState().report('s1', [{ ...scopeItem, helpUrl: 'https://example.test/permissions' }]);
    render(<ConnectorRequiredCards />);
    expect(screen.getByTestId('connector-required-help-link')).toBeTruthy();
    expect(screen.getByTestId('connector-required-reauthorize')).toBeTruthy();
  });

  it('click 重新授权 → host action with the missing scope → success state asks to resend', async () => {
    ipcMock.reauthorize.mockResolvedValue({ success: true });
    useConnectorRequiredStore.getState().report('s1', [scopeItem]);
    render(<ConnectorRequiredCards />);
    await act(async () => { fireEvent.click(screen.getByTestId('connector-required-reauthorize')); });
    expect(ipcMock.reauthorize).toHaveBeenCalledWith('domain:mcp', { serverName: 'notion', requiredScope: 'write' });
    expect(screen.getByTestId('connector-required-card-notion').textContent).toContain('已重新授权，请重新发送刚才的请求');
    expect(screen.queryByTestId('connector-required-reauthorize')).toBeNull();
  });

  it('denied / failed authorization keeps the card with the failure and lets the user retry', async () => {
    ipcMock.reauthorize.mockResolvedValueOnce({ success: false, error: 'declined' }).mockResolvedValueOnce({ success: true });
    useConnectorRequiredStore.getState().report('s1', [scopeItem]);
    render(<ConnectorRequiredCards />);
    await act(async () => { fireEvent.click(screen.getByTestId('connector-required-reauthorize')); });
    expect(screen.getByTestId('connector-required-reauth-error').textContent).toContain('declined');
    await act(async () => { fireEvent.click(screen.getByTestId('connector-required-reauthorize')); });
    expect(screen.getByTestId('connector-required-card-notion').textContent).toContain('已重新授权');
  });

  it('after successful reauthorize, 知道了 clears the entry so later cards for the same connector can reappear', async () => {
    ipcMock.reauthorize.mockResolvedValue({ success: true });
    useConnectorRequiredStore.getState().report('s1', [scopeItem]);
    render(<ConnectorRequiredCards />);
    await act(async () => { fireEvent.click(screen.getByTestId('connector-required-reauthorize')); });
    await act(async () => { fireEvent.click(screen.getByTestId('connector-required-dismiss')); });
    expect(screen.queryByTestId('connector-required-card-notion')).toBeNull();
    act(() => { useConnectorRequiredStore.getState().report('s1', [scopeItem]); });
    expect(screen.getByTestId('connector-required-card-notion')).toBeTruthy();
    act(() => { useConnectorRequiredStore.getState().report('s1', [{ id: 'notion', source: 'selected', reason: 'not_connected' }]); });
    expect(useConnectorRequiredStore.getState().entries['s1::notion']?.status).toBe('pending');
  });

  it('is NOT auto-resolved by the watcher while the connector reports connected', async () => {
    vi.useFakeTimers();
    useConnectorRequiredStore.getState().report('s1', [scopeItem]);
    render(<ConnectorRequiredCards />);
    const stop = startConnectorRequiredWatcher();
    await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTOR_REQUIRED_POLL.INTERVAL_MS * 3); });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useConnectorRequiredStore.getState().entries['s1::notion']?.status).toBe('pending');
    expect(screen.getByTestId('connector-required-card-notion').textContent).toContain('缺少这次操作需要的权限');
    stop();
  });

  it('parseConnectorRequiredPayload keeps requiredScope/helpUrl and drops empties', () => {
    expect(parseConnectorRequiredPayload({ connectors: [{ id: 'notion', source: 'selected', reason: 'insufficient_scope', requiredScope: 'write', helpUrl: '' }] }))
      .toEqual([{ id: 'notion', source: 'selected', reason: 'insufficient_scope', requiredScope: 'write' }]);
  });
});

describe('lost_login connector card', () => {
  const cliItem = { id: 'feishu', source: 'selected' as const, reason: 'lost_login', lostCode: 'cli_not_logged_in' as const };
  const mcpItem = { id: 'notion', source: 'selected' as const, reason: 'lost_login', lostCode: 'mcp_oauth_authorization_required' as const };

  beforeEach(() => {
    ipcMock.reauthorize.mockReset();
    ipcMock.invokeDomain.mockReset();
    ipcMock.invokeDomain.mockImplementation(async (domain: string, method: string, payload: unknown) => {
      if (method === 'reauthorizeServer' || method === 'oauthConnect') return ipcMock.reauthorize(domain, payload, method);
      return [];
    });
    sendPrompt.mockClear();
    useConnectorRequiredStore.setState({ entries: {} });
    useAppStore.setState({ language: 'zh' } as never);
    useMessageActionStore.setState({ _send: vi.fn(), sendPrompt } as never);
    useSessionStore.setState({ currentSessionId: 's1', runningSessionIds: new Set() });
  });

  it('CLI: names the connector, states the truthful reason, no code names; 重新连接 runs the settings-page connect action then asks to resend', async () => {
    ipcMock.reauthorize.mockResolvedValue({ alreadyConnected: false });
    useConnectorRequiredStore.getState().report('s1', [cliItem]);
    render(<ConnectorRequiredCards />);
    const text = screen.getByTestId('connector-required-card-feishu').textContent ?? '';
    expect(text).toContain('飞书');
    expect(text).toContain('当前未登录，请重新连接后继续');
    expect(text).toContain('命令行工具当前没有报告已登录');
    expect(text).not.toMatch(/cli_|lost_login|过期|撤销|expired|revoked/);
    expect(screen.getByTestId('connector-required-reconnect').textContent).toBe('重新连接');
    await act(async () => { fireEvent.click(screen.getByTestId('connector-required-reconnect')); });
    expect(ipcMock.reauthorize).toHaveBeenCalledWith('domain:connector', { providerId: 'feishu' }, 'oauthConnect');
    expect(screen.getByTestId('connector-required-card-feishu').textContent).toContain('已重新连接，请重新发送刚才的请求');
    expect(sendPrompt).not.toHaveBeenCalled(); // 不自动重放
  });

  it('MCP 401: says 重新授权 wording (never expired/revoked) and Reconnect calls reauthorizeServer; failure keeps the button', async () => {
    ipcMock.reauthorize.mockResolvedValueOnce({ success: false, error: 'declined' });
    useConnectorRequiredStore.getState().report('s1', [mcpItem]);
    render(<ConnectorRequiredCards />);
    const text = screen.getByTestId('connector-required-card-notion').textContent ?? '';
    expect(text).toContain('它的服务端要求重新授权');
    expect(text).not.toMatch(/过期|撤销|expired|revoked/);
    await act(async () => { fireEvent.click(screen.getByTestId('connector-required-reconnect')); });
    expect(ipcMock.reauthorize).toHaveBeenCalledWith('domain:mcp', { serverName: 'notion' }, 'reauthorizeServer');
    // 英文原始错误不外露；中文原因才附带
    expect(screen.getByTestId('connector-required-reauth-error').textContent).toBe('重新连接没有完成，请稍后再试');
    expect(screen.getByTestId('connector-required-reconnect')).toBeTruthy();
    ipcMock.reauthorize.mockResolvedValueOnce({ success: false, error: '用户取消了授权' });
    await act(async () => { fireEvent.click(screen.getByTestId('connector-required-reconnect')); });
    expect(screen.getByTestId('connector-required-reauth-error').textContent).toBe('重新连接没有完成，请稍后再试：用户取消了授权');
  });

  it('「稍后」后再次触发 lost_login → 卡片重新出现；insufficient_scope 的「稍后」仍永久静音', () => {
    const store = useConnectorRequiredStore.getState();
    store.report('s1', [cliItem, scopeItem]);
    store.dismiss('s1', 'feishu');
    store.dismiss('s1', 'notion');
    act(() => { useConnectorRequiredStore.getState().report('s1', [cliItem, scopeItem]); });
    expect(useConnectorRequiredStore.getState().entries['s1::feishu']?.status).toBe('pending');
    expect(useConnectorRequiredStore.getState().entries['s1::notion']?.status).toBe('dismissed');
    render(<ConnectorRequiredCards />);
    expect(screen.getByTestId('connector-required-card-feishu')).toBeTruthy();
    expect(screen.queryByTestId('connector-required-card-notion')).toBeNull();
  });

  it('parseConnectorRequiredPayload keeps a known lostCode and drops unknown ones', () => {
    expect(parseConnectorRequiredPayload({ connectors: [
      { id: 'feishu', source: 'selected', reason: 'lost_login', lostCode: 'cli_not_logged_in' },
      { id: 'tmeet', source: 'selected', reason: 'lost_login', lostCode: 'cli_token_expired' },
    ] })).toEqual([
      { id: 'feishu', source: 'selected', reason: 'lost_login', lostCode: 'cli_not_logged_in' },
      { id: 'tmeet', source: 'selected', reason: 'lost_login' },
    ]);
  });
});
