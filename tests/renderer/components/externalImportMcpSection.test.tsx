// @vitest-environment jsdom
// ============================================================================
// ExternalImportMcpSection renderer 测试（N-EXTHISTORY-IMPORT-K1B-MCP）：
// 1. 预览卡：坏文件给文件级原因行；条目行带 名称·来源·类型·命令摘要；
//    跳过项灰显给 i18n 原因标签；needs KEY 行在场（验收①③的 UI 半）。
// 2. 结果卡：导入项标「已导入（未启用）」+ 启用开关；点开关先弹确认对话框，
//    对话框里是完整命令行，确认前不调 setServerEnabled；确认后才启用（验收②）。
// 3. 取消确认 → 不启用。远程项确认对话框给地址引导文案。
// ============================================================================

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ExternalMcpApplyResult,
  ExternalMcpPreviewResult,
} from '../../../src/shared/contract/externalImport';
import { IPC_DOMAINS } from '../../../src/shared/ipc/domains';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain,
    on: () => () => {},
    off: vi.fn(),
  },
}));

import { zh } from '../../../src/renderer/i18n';
import {
  ExternalImportMcpPreview,
  ExternalImportMcpResults,
} from '../../../src/renderer/components/features/settings/tabs/ExternalImportMcpSection';

const copy = zh.settings.externalImportMcp;
const sourceNames = zh.settings.externalImport.sourceNames;

beforeEach(() => {
  invokeDomain.mockReset();
  invokeDomain.mockResolvedValue({ success: true });
});

afterEach(cleanup);

function previewFixture(): ExternalMcpPreviewResult {
  return {
    files: [
      { sourceId: 'claude-code', configPath: '/h/.claude.json', status: 'ok' },
      { sourceId: 'cursor', configPath: '/h/.cursor/mcp.json', status: 'invalid', error: 'invalid JSON: boom' },
    ],
    items: [
      {
        sourceId: 'claude-code',
        name: 'github',
        disposition: 'import',
        kind: 'stdio',
        commandSummary: 'npx -y @modelcontextprotocol/server-github',
        neededEnvKeys: ['GITHUB_TOKEN'],
        dedupKey: '["npx","-y","@modelcontextprotocol/server-github"]',
      },
      {
        sourceId: 'cursor',
        name: 'github',
        disposition: 'skip',
        reason: 'duplicate-across-sources',
        kind: 'stdio',
        commandSummary: 'npx -y @modelcontextprotocol/server-github',
        neededEnvKeys: [],
        dedupKey: '["npx","-y","@modelcontextprotocol/server-github"]',
      },
      {
        sourceId: 'cursor',
        name: 'off-server',
        disposition: 'skip',
        reason: 'source-disabled',
        kind: 'stdio',
        commandSummary: 'npx -y off-mcp',
        neededEnvKeys: [],
        dedupKey: '',
      },
    ],
    summary: { import: 1, skip: 2 },
  };
}

function applyFixture(): ExternalMcpApplyResult {
  return {
    targetPath: '/data/mcp.json',
    imported: 2,
    skipped: 1,
    items: [
      {
        sourceId: 'claude-code',
        name: 'github',
        action: 'imported',
        disposition: 'import',
        kind: 'stdio',
        commandSummary: 'npx -y @modelcontextprotocol/server-github',
        neededEnvKeys: ['GITHUB_TOKEN'],
        dedupKey: '["npx"]',
      },
      {
        sourceId: 'codex',
        name: 'sentinel',
        action: 'imported',
        disposition: 'import',
        kind: 'remote',
        commandSummary: 'https://mcp.example.com/stream',
        neededEnvKeys: [],
        dedupKey: 'https://mcp.example.com/stream',
      },
      {
        sourceId: 'cursor',
        name: 'off-server',
        action: 'skipped',
        disposition: 'skip',
        reason: 'source-disabled',
        kind: 'stdio',
        commandSummary: '',
        neededEnvKeys: [],
        dedupKey: '',
      },
    ],
  };
}

describe('ExternalImportMcpPreview', () => {
  it('坏文件给文件级原因行；条目行含来源/命令摘要/needs KEY；跳过项带原因标签', () => {
    render(<ExternalImportMcpPreview copy={copy} sourceNames={sourceNames} preview={previewFixture()} />);

    // 文件级原因（验收①：坏文件不静默）
    expect(screen.getByTestId('external-import-mcp-file-cursor').textContent).toContain('MCP 配置文件解析失败');
    expect(screen.getByTestId('external-import-mcp-file-cursor').textContent).toContain('invalid JSON: boom');

    // 导入项：needs KEY 行（验收③）
    const github = screen.getByTestId('external-import-mcp-item-claude-code-github');
    expect(github.textContent).toContain('Claude Code');
    expect(github.textContent).toContain('npx -y @modelcontextprotocol/server-github');
    expect(github.textContent).toContain('需要先补 GITHUB_TOKEN 才能用');

    // 跳过项：i18n 原因标签
    expect(screen.getByTestId('external-import-mcp-item-cursor-off-server').textContent).toContain('来源应用里已停用，跳过');
  });
});

describe('ExternalImportMcpResults', () => {
  it('导入项默认「已导入（未启用）」；点开关先弹完整命令确认，确认前不启用', async () => {
    render(<ExternalImportMcpResults copy={copy} sourceNames={sourceNames} result={applyFixture()} />);

    const githubRow = screen.getByTestId('external-import-mcp-item-claude-code-github');
    expect(githubRow.textContent).toContain('已导入（未启用）');

    // 点启用开关 → 对话框先给完整命令行（验收②）
    fireEvent.click(screen.getAllByRole('switch')[0]);
    const dialog = screen.getByTestId('external-import-mcp-enable-content');
    expect(dialog.textContent).toContain('启用后 Neo 会在你的电脑上运行：');
    expect(dialog.textContent).toContain('npx -y @modelcontextprotocol/server-github');
    expect(invokeDomain).not.toHaveBeenCalled();

    // 确认后才真正启用
    fireEvent.click(screen.getByText('确认启用'));
    expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.MCP,
      'setServerEnabled',
      { serverName: 'github', enabled: true },
    );
    await waitFor(() => expect(githubRow.textContent).toContain('已启用'));
  });

  it('取消确认 → 不启用', () => {
    render(<ExternalImportMcpResults copy={copy} sourceNames={sourceNames} result={applyFixture()} />);

    fireEvent.click(screen.getAllByRole('switch')[0]);
    fireEvent.click(screen.getByText('暂不启用'));
    expect(invokeDomain).not.toHaveBeenCalled();
  });

  it('远程项确认对话框给「连接地址」引导文案', () => {
    render(<ExternalImportMcpResults copy={copy} sourceNames={sourceNames} result={applyFixture()} />);

    fireEvent.click(screen.getAllByRole('switch')[1]);
    const dialog = screen.getByTestId('external-import-mcp-enable-content');
    expect(dialog.textContent).toContain('启用后 Neo 会连接这个地址：');
    expect(dialog.textContent).toContain('https://mcp.example.com/stream');
  });
});
