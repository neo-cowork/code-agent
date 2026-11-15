// @vitest-environment jsdom
// ============================================================================
// ExternalImportMcpSection renderer 测试（N-EXTHISTORY-IMPORT-K1B-MCP-REDESIGN）
// ============================================================================

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ExternalMcpApplyResult,
  ExternalMcpPreviewResult,
} from '../../../../src/shared/contract/externalImport';
import { IPC_DOMAINS } from '../../../../src/shared/ipc/domains';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain,
    on: () => () => {},
    off: vi.fn(),
  },
}));

import { zh } from '../../../../src/renderer/i18n';
import {
  ExternalImportMcpPreview,
  ExternalImportMcpResults,
} from '../../../../src/renderer/components/features/settings/tabs/ExternalImportMcpSection';

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
      { sourceId: 'cursor', configPath: '/h/.cursor/mcp.json', status: 'invalid', error: 'invalid JSON: parse error' },
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
        name: 'db-placeholder',
        disposition: 'skip',
        reason: 'placeholder-in-command',
        kind: 'stdio',
        commandSummary: 'npx -y db-mcp ${DB_URL}',
        neededEnvKeys: [],
        dedupKey: '',
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
        name: 'db-placeholder',
        action: 'skipped',
        disposition: 'skip',
        reason: 'placeholder-in-command',
        kind: 'stdio',
        commandSummary: 'npx -y db-mcp ${DB_URL}',
        neededEnvKeys: [],
        dedupKey: '',
      },
    ],
  };
}

describe('ExternalImportMcpPreview', () => {
  it('坏文件给文件级原因行；条目行含来源/命令摘要/needs KEY；${…} 与停用项显示明确跳过原因（验收①③）', () => {
    render(<ExternalImportMcpPreview copy={copy} sourceNames={sourceNames} preview={previewFixture()} />);

    expect(screen.getByTestId('external-import-mcp-file-cursor').textContent).toContain('MCP 配置文件格式有误，无法解析');

    const github = screen.getByTestId('external-import-mcp-item-claude-code-github');
    expect(github.textContent).toContain('Claude Code');
    expect(github.textContent).toContain('npx -y @modelcontextprotocol/server-github');
    expect(github.textContent).toContain('需要先补 GITHUB_TOKEN 才能用');

    expect(screen.getByTestId('external-import-mcp-item-cursor-db-placeholder').textContent).toContain('包含 Neo 无法展开的变量（${…}）');
    expect(screen.getByTestId('external-import-mcp-item-cursor-off-server').textContent).toContain('在原应用里已停用');
  });
});

describe('ExternalImportMcpResults', () => {
  it('导入项默认「已导入（未启用）」；点开关先弹完整命令确认，确认前不启用，确认后才启用（验收②）', async () => {
    render(<ExternalImportMcpResults copy={copy} sourceNames={sourceNames} result={applyFixture()} />);

    const githubRow = screen.getByTestId('external-import-mcp-item-claude-code-github');
    expect(githubRow.textContent).toContain('已导入（未启用）');

    fireEvent.click(screen.getAllByRole('switch')[0]);
    const dialog = screen.getByTestId('external-import-mcp-enable-content');
    expect(dialog.textContent).toContain('启用后 Neo 会在你的电脑上运行：');
    expect(dialog.textContent).toContain('npx -y @modelcontextprotocol/server-github');
    expect(invokeDomain).not.toHaveBeenCalled();

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
