// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { findRecommendedMcpServer, getBuiltinMcpCatalogPayload } from '../../../src/shared/constants/mcpCatalog';

const environment = vi.hoisted(() => ({
  isWebMode: false,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: environment.language === 'en' ? en : zh, language: environment.language }),
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => environment.isWebMode,
}));

import { McpDiscoverTab, type McpDiscoverTabProps } from '../../../src/renderer/components/features/settings/tabs/McpDiscoverTab';

const discoverText = zh.settings.mcp.discover;

function renderDiscover(overrides: Partial<McpDiscoverTabProps> = {}) {
  const props: McpDiscoverTabProps = {
    catalog: getBuiltinMcpCatalogPayload(),
    existingServerIds: new Set<string>(),
    enabledServerIds: new Set<string>(),
    canManageMcp: true,
    actionLoading: new Set<string>(),
    onAdd: vi.fn(),
    onEnableBuiltin: vi.fn(),
    ...overrides,
  };
  render(React.createElement(McpDiscoverTab, props));
  return props;
}

describe('McpDiscoverTab unified grid cards', () => {
  afterEach(() => {
    cleanup();
    environment.isWebMode = false;
    environment.language = 'zh';
  });

  it('keeps capability copy on the card and moves runtime details into the modal', () => {
    renderDiscover();

    const fetchCard = screen.getByTestId('mcp-discover-card-fetch');
    expect(fetchCard.textContent).toContain(findRecommendedMcpServer('fetch')!.description);
    expect(fetchCard.textContent).not.toContain('APP_SECRET');

    fireEvent.click(fetchCard);
    expect(screen.getByTestId('mcp-discover-runtime-fetch').textContent).toBe('UVX');
    expect(screen.getByTestId('mcp-discover-tools-fetch').textContent).toContain('fetch');
    expect(screen.getByText(discoverText.grid.tryIt)).toBeTruthy();
  });

  it('renders declared brand logos and keeps the Lucide fallback for entries without one', () => {
    renderDiscover();

    const exaCard = screen.getByTestId('mcp-discover-card-exa');
    const exaLogo = within(exaCard).getByRole('img', { name: 'Exa AI 搜索' });
    expect(exaLogo.parentElement?.className).toContain('h-7');
    expect(exaLogo.parentElement?.className).toContain('w-7');
    fireEvent.click(exaCard);
    const exaDetailLogo = within(screen.getByTestId('mcp-discover-detail-exa'))
      .getByRole('img', { name: 'Exa AI 搜索' });
    expect(exaDetailLogo.parentElement?.className).toContain('h-8');
    expect(exaDetailLogo.parentElement?.className).toContain('w-8');

    for (const [id, name] of [
      ['notion', 'Notion'],
      ['tencent-survey', '腾讯问卷'],
      ['tencent-weiyun', '腾讯微云'],
      ['puppeteer', 'Puppeteer'],
      ['deepwiki', 'DeepWiki'],
      ['tencent-map', '腾讯地图'],
      ['amap', '高德地图'],
    ]) {
      const card = screen.getByTestId(`mcp-discover-card-${id}`);
      expect(within(card).getByRole('img', { name })).toBeTruthy();
    }

    const fetchCard = screen.getByTestId('mcp-discover-card-fetch');
    expect(within(fetchCard).queryByRole('img')).toBeNull();
    const fallback = fetchCard.querySelector('svg');
    expect(fallback?.classList.contains('h-7')).toBe(true);
    expect(fallback?.classList.contains('w-7')).toBe(true);
  });

  it('shows install-after-connect for entries without a curated tool list', () => {
    renderDiscover();
    fireEvent.click(screen.getByTestId('mcp-discover-card-task_master'));

    expect(screen.getByTestId('mcp-discover-tools-task_master').textContent)
      .toContain(discoverText.toolsVisibleAfterInstall);
  });

  it('removes configured servers from discovery so the grid has one card per connector', () => {
    renderDiscover({ existingServerIds: new Set(['excel']) });

    expect(screen.queryByTestId('mcp-discover-card-excel')).toBeNull();
    expect(screen.getByTestId('mcp-discover-card-playwright')).toBeTruthy();
  });

  it('merges the read-only lark entry into the SaaS Feishu detail instead of rendering a second card', () => {
    renderDiscover();

    expect(screen.queryByTestId('mcp-discover-card-lark')).toBeNull();
  });

  it('does not synthesize a Computer Use card in the discovery shelf', () => {
    renderDiscover();

    expect(screen.queryByTestId('mcp-computer-use-card')).toBeNull();
    expect(screen.queryByText(/Computer Use 本机能力/)).toBeNull();
  });

  it('shows every live-approved remote Tencent connector as not connected', () => {
    renderDiscover();

    for (const id of [
      'tencent-docs',
      'tencent-docs-oa',
      'tencent-survey',
      'tencent-weiyun',
      'tencent-map',
    ]) {
      expect(screen.getByTestId(`mcp-discover-card-${id}`).textContent)
        .toContain(discoverText.grid.notConnected);
    }
  });

  it('opens details first, then routes add through the prefilled editor callback', () => {
    const props = renderDiscover();
    fireEvent.click(screen.getByTestId('mcp-discover-card-excel'));
    fireEvent.click(screen.getByTestId('mcp-discover-add-excel'));

    expect(props.onAdd).toHaveBeenCalledTimes(1);
    expect(props.onAdd).toHaveBeenCalledWith(expect.objectContaining({
      id: 'excel',
      connection: expect.objectContaining({ type: 'stdio', command: 'npx' }),
    }));
    expect(props.onEnableBuiltin).not.toHaveBeenCalled();
  });

  it('routes a disabled built-in server to enable instead of add', () => {
    const props = renderDiscover();
    const exaCard = screen.getByTestId('mcp-discover-card-exa');
    fireEvent.click(exaCard);
    fireEvent.click(within(screen.getByRole('dialog')).getByText(discoverText.enable));

    expect(props.onEnableBuiltin).toHaveBeenCalledWith('exa');
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it.each([
    { state: 'web mode', web: true, canManageMcp: true, reason: discoverText.grid.addDesktopOnly },
    { state: 'no admin permission', web: false, canManageMcp: false, reason: discoverText.grid.addRequiresAdmin },
    { state: 'web mode without admin permission', web: true, canManageMcp: false, reason: discoverText.grid.addDesktopOnly },
  ])('explains disabled Add in $state for Notion and Supabase', ({ web, canManageMcp, reason }) => {
    environment.isWebMode = web;
    const catalog = getBuiltinMcpCatalogPayload();
    const fixtureValue = 'fixture-credential-value-must-stay-hidden';
    renderDiscover({
      canManageMcp,
      catalog: {
        ...catalog,
        servers: catalog.servers.map((entry) => {
          if (entry.id !== 'supabase' || entry.connection?.type !== 'stdio') return entry;
          return { ...entry, connection: { ...entry.connection, env: { SUPABASE_ACCESS_TOKEN: fixtureValue } } };
        }),
      },
    });

    for (const [id, credential] of [
      ['notion', discoverText.grid.browserSignIn],
      ['supabase', 'SUPABASE_ACCESS_TOKEN'],
    ]) {
      fireEvent.click(screen.getByTestId(`mcp-discover-card-${id}`));
      const dialog = screen.getByRole('dialog');
      const detail = within(dialog);
      const add = detail.getByRole<HTMLButtonElement>('button', { name: discoverText.add });
      expect(add.disabled).toBe(true);
      const reasonNode = detail.getByTestId(`mcp-discover-add-disabled-reason-${id}`);
      expect(reasonNode.textContent).toBe(reason);
      expect(reasonNode.id).toBe(add.getAttribute('aria-describedby'));
      expect(reasonNode.previousElementSibling).toBe(add);
      expect(detail.getByText(discoverText.requiredCredentialsPrefix + credential)).toBeTruthy();
      expect(detail.queryByText(discoverText.grid.secretInNextStep)).toBeNull();
      expect(dialog.textContent).not.toContain(fixtureValue);
      fireEvent.keyDown(document, { key: 'Escape' });
    }
  });

  it('explains disabled Enable in web mode and retains the no-config line', () => {
    environment.isWebMode = true;
    renderDiscover();
    fireEvent.click(screen.getByTestId('mcp-discover-card-puppeteer'));

    const detail = within(screen.getByRole('dialog'));
    const enable = detail.getByRole<HTMLButtonElement>('button', { name: discoverText.enable });
    expect(enable.disabled).toBe(true);
    const reason = detail.getByTestId('mcp-discover-add-disabled-reason-puppeteer');
    expect(reason.textContent).toBe(discoverText.grid.enableDesktopOnly);
    expect(reason.id).toBe(enable.getAttribute('aria-describedby'));
    expect(detail.getByText(discoverText.noConfig)).toBeTruthy();
  });

  it('keeps the setup panel hint and omits the disabled reason when Add is enabled', () => {
    renderDiscover();
    fireEvent.click(screen.getByTestId('mcp-discover-card-notion'));

    const detail = within(screen.getByRole('dialog'));
    const add = detail.getByRole<HTMLButtonElement>('button', { name: discoverText.add });
    expect(add.disabled).toBe(false);
    expect(add.hasAttribute('aria-describedby')).toBe(false);
    expect(detail.queryByTestId('mcp-discover-add-disabled-reason-notion')).toBeNull();
    expect(detail.getByText(discoverText.grid.secretInNextStep)).toBeTruthy();
  });

  it('renders the disabled Notion detail entirely in English', () => {
    environment.isWebMode = true;
    environment.language = 'en';
    renderDiscover();
    fireEvent.click(screen.getByTestId('mcp-discover-card-notion'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Needs: Sign in via browser')).toBeTruthy();
    expect(within(dialog).getByTestId('mcp-discover-add-disabled-reason-notion').textContent)
      .toBe(en.settings.mcp.discover.grid.addDesktopOnly);
    expect(dialog.textContent).not.toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u);
  });
});
