import { describe, expect, it } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { getConnectorCardPresentation } from '../../../src/renderer/utils/connectorCardPresentation';
import type { WorkbenchMcpRegistryItem } from '../../../src/renderer/utils/workbenchCapabilityRegistry';

const baseServer: WorkbenchMcpRegistryItem = {
  kind: 'mcp',
  key: 'mcp:search',
  id: 'search',
  label: 'Search',
  selected: false,
  status: 'connected',
  enabled: true,
  transport: 'http-streamable',
  toolCount: 2,
  resourceCount: 0,
  description: 'Search trusted sources',
  available: true,
  turnReadiness: 'ready',
  autoAllowed: true,
  blocked: false,
  visibleInWorkbench: true,
  health: 'healthy',
  lifecycle: {
    installState: 'not_applicable',
    mountState: 'not_applicable',
    connectionState: 'connected',
  },
};

describe('getConnectorCardPresentation', () => {
  it('maps every card state to the chosen zh and en wording', () => {
    const cases = [
      ['connected', true, 'connected', '已连接', 'Connected'],
      ['lazy', true, 'lazy', '需要时自动连接', 'Connects when needed'],
      ['disabled', false, 'connected', '已停用', 'Disabled'],
      ['error', true, 'error', '连接失败', 'Connection failed'],
      ['connecting', true, 'connecting', '连接中', 'Connecting'],
      ['disconnected', true, 'disconnected', '未连接', 'Not connected'],
    ] as const;

    for (const [, enabled, connectionState, zhLabel, enLabel] of cases) {
      const server = {
        ...baseServer,
        enabled,
        lifecycle: { ...baseServer.lifecycle, connectionState },
      };
      expect(getConnectorCardPresentation(server, zh.settings.mcp.grid.cardStatus).statusLabel).toBe(zhLabel);
      expect(getConnectorCardPresentation(server, en.settings.mcp.grid.cardStatus).statusLabel).toBe(enLabel);
    }
  });

  it('uses the catalog purpose before an error and keeps transport and status out of the tooltip', () => {
    const presentation = getConnectorCardPresentation(
      { ...baseServer, error: 'Connection timed out' },
      en.settings.mcp.grid.cardStatus,
      { displayName: 'Web search' },
    );

    expect(presentation.description).toBe('Search trusted sources');
    expect(presentation.title).toBe('Web search\nSearch trusted sources');
    expect(presentation.title).not.toMatch(/transport:|http-streamable|status:/i);
  });

  it('falls back to the error reason when no catalog purpose exists', () => {
    const presentation = getConnectorCardPresentation(
      { ...baseServer, description: undefined, error: 'Connection timed out' },
      en.settings.mcp.grid.cardStatus,
    );

    expect(presentation.description).toBe('Connection timed out');
  });
});
