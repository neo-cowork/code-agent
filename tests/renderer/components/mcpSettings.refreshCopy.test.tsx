// @vitest-environment jsdom
// MCPSettings 刷新按钮与成功提示：面向用户的文案不出现 MCP
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchMcpRegistryItem } from '../../../src/renderer/utils/workbenchCapabilityRegistry';

const { mockInvokeDomain, mockRunQuickAction, mockUseInChat, mockLanguage } = vi.hoisted(() => ({
  mockInvokeDomain: vi.fn(),
  mockRunQuickAction: vi.fn(),
  mockUseInChat: vi.fn(),
  mockLanguage: { value: 'zh' as 'zh' | 'en' },
}));

const mcpServers: WorkbenchMcpRegistryItem[] = [];

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh: zhText } = await import('../../../src/renderer/i18n/zh');
  const { en: enText } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({
      t: mockLanguage.value === 'en' ? enText : zhText,
      language: mockLanguage.value,
    }),
  };
});

vi.mock('../../../src/renderer/hooks/useMcpStatus', () => ({
  useMcpStatus: () => ({
    status: { connectedServers: [], toolCount: 0, resourceCount: 0 },
    serverStates: [],
    isLoading: false,
    reload: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({
    items: mcpServers,
    skills: [],
    connectors: [],
    mcpServers,
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchInsights', () => ({
  useWorkbenchInsights: () => ({
    capabilities: { skills: [], connectors: [], mcpServers: [] },
    invocationSummary: { skills: {}, connectors: {}, mcpServers: {} },
    references: [],
    history: [],
    connectorHistory: [],
    mcpHistory: [],
    skillHistory: [],
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner', () => ({
  useWorkbenchCapabilityQuickActionRunner: () => ({
    runningActionKey: null,
    actionErrors: {},
    completedActions: {},
    runQuickAction: mockRunQuickAction,
  }),
}));

vi.mock('../../../src/renderer/hooks/useConnectorInChat', () => ({
  useConnectorInChat: () => mockUseInChat,
}));

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } }) => unknown) => selector({
    user: { isAdmin: false },
  }),
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: mockInvokeDomain,
  },
}));

vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({
  WebModeBanner: () => null,
}));

vi.mock('../../../src/renderer/components/features/settings/sections/localBridge', () => ({
  LocalBridgeSection: () => React.createElement('div', null, 'LocalBridge'),
}));

// 卡片锚点按真实 testid 伪造：hook 据此定位滚动目标
vi.mock('../../../src/renderer/components/features/settings/sections', () => ({
  NativeConnectorsSection: () => React.createElement(
    'div',
    { 'data-testid': 'native-connector-card-mail' },
    'MailCard',
  ),
  SaaSConnectorsSection: () => React.createElement(
    'div',
    { 'data-testid': 'saas-connector-feishu' },
    'FeishuCard',
  ),
}));

vi.mock('../../../src/renderer/components/features/settings/McpServerEditor', () => ({
  McpServerEditor: () => null,
}));

vi.mock('../../../src/renderer/components/features/settings/tabs/McpDiscoverTab', () => ({
  McpDiscoverTab: () => null,
}));

import { MCPSettings } from '../../../src/renderer/components/features/settings/tabs/MCPSettings';

const MCP_WORD = /\bmcp\b/i;

describe('MCPSettings refresh-from-cloud copy', () => {
  const domainInvoke = vi.fn();

  beforeEach(() => {
    mockLanguage.value = 'zh';
    domainInvoke.mockReset();
    domainInvoke.mockResolvedValue({ success: true });
    (window as unknown as { domainAPI: unknown }).domainAPI = { invoke: domainInvoke };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { domainAPI?: unknown }).domainAPI;
  });

  it.each([
    ['zh', '从云端刷新外部工具配置', '外部工具配置已从云端刷新'],
    ['en', 'Refresh external tools config from cloud', 'External tools configuration refreshed from cloud'],
  ] as const)('%s: button and success toast say external tools, never MCP', async (language, label, toast) => {
    mockLanguage.value = language;
    render(React.createElement(MCPSettings));

    const buttons = screen.getAllByText(label);
    expect(buttons.length).toBeGreaterThan(0);
    for (const node of buttons) expect(node.textContent).not.toMatch(MCP_WORD);

    fireEvent.click(buttons[0]);
    const shown = await screen.findByText(toast);
    expect(domainInvoke).toHaveBeenCalledWith('domain:mcp', 'refreshFromCloud');
    expect(shown.textContent).not.toMatch(MCP_WORD);
    console.log(`[toast:${language}] ${shown.textContent}`);
  });
});
