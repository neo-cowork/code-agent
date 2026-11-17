// @vitest-environment jsdom
// 全局记忆确认卡：真 ToolExecutor 门 → 真 requestDirectiveMemoryConfirmation 广播 → MemoryConfirmModal。
// 卡面只能是一句人话，不得出现 JSON / 工具名 / directive / 英文分类串。
import * as fs from 'node:fs';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryConfirmRequest } from '../../../src/shared/contract/memory';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  execute: vi.fn(),
  getSchemas: vi.fn(),
  has: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../../../src/host/platform/windowBridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/platform/windowBridge')>(),
  broadcastToRenderer: mocks.broadcast,
  hasInteractiveUi: () => true,
}));
vi.mock('../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: () => ({ getSchemas: mocks.getSchemas, has: mocks.has, resolve: mocks.resolve }),
  isProtocolToolName: vi.fn(() => false),
  resetProtocolRegistry: vi.fn(),
}));
vi.mock('../../../src/host/tools/protocolToolRegistration', () => ({
  getProtocolToolSchemas: mocks.getSchemas,
  hasProtocolTool: mocks.has,
  resolveProtocolTool: mocks.resolve,
  registerProtocolTool: vi.fn(),
  unregisterProtocolTool: vi.fn(),
  setProtocolToolRegistryPort: vi.fn(),
}));
vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getAllToolMeta: () => ({}) }),
}));
vi.mock('../../../src/host/mcp', () => ({
  getMCPClient: () => ({ getToolDefinitions: () => [], parseMCPToolName: () => null }),
}));
vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false, get: () => null, set: vi.fn(),
    invalidateForPath: vi.fn(), invalidateForWorkspace: vi.fn(),
  }),
}));
vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { resetToolResolver } = await import('../../../src/host/tools/dispatch/toolResolver');
const { respondToDirectiveMemoryConfirmation, clearDirectiveMemoryConfirmationsForTest } =
  await import('../../../src/host/memory/directiveMemoryConfirmation');
const { useAppStore } = await import('../../../src/renderer/stores/appStore');
const { MemoryConfirmModal } = await import('../../../src/renderer/components/features/memory/MemoryConfirmModal');

const schemas = [
  {
    name: 'MemoryWrite',
    description: 'write memory',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string' }, scope: { type: 'string' }, filename: { type: 'string' }, content: { type: 'string' } },
      required: ['action', 'filename'],
    },
    category: 'fs',
    permissionLevel: 'write',
    pathAuthority: [{ kind: 'global-memory', pathParameter: 'filename' }],
  },
  {
    name: 'Bash',
    description: 'execute shell',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    category: 'shell',
    permissionLevel: 'execute',
    pathAuthority: [{ kind: 'shell', commandParameter: 'command' }],
  },
];

const MEMORY_TEXT = '汇报先写结论，再写过程；这条对我所有项目都适用。';

async function captureCard(tool: string, params: Record<string, unknown>): Promise<{ request: MemoryConfirmRequest; done: Promise<unknown> }> {
  const executor = new ToolExecutor({ workingDirectory: '/tmp', requestPermission: vi.fn(async () => true) });
  executor.setAuditEnabled(false);
  const done = executor.execute(tool, params, { preApprovedTools: new Set([tool]) });
  await vi.waitFor(() => expect(mocks.broadcast).toHaveBeenCalledOnce());
  return { request: mocks.broadcast.mock.calls[0][1] as MemoryConfirmRequest, done };
}

function expectPlain(text: string) {
  for (const raw of ['{"', 'MemoryWrite', 'Bash', 'directive', 'Persistent memory']) {
    expect(text.toLowerCase()).not.toContain(raw.toLowerCase());
  }
}

describe('全局记忆确认卡用人话', () => {
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
  beforeEach(() => {
    process.env.CODE_AGENT_DATA_DIR = '/tmp/code-agent-directive-plain';
    resetToolResolver();
    mocks.getSchemas.mockReturnValue(schemas);
    mocks.has.mockReturnValue(true);
    mocks.execute.mockReset().mockResolvedValue({ ok: true, output: 'written' });
    mocks.resolve.mockResolvedValue({ execute: mocks.execute });
    mocks.broadcast.mockReset();
  });
  afterEach(() => {
    cleanup();
    clearDirectiveMemoryConfirmationsForTest();
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
  });

  it('MemoryWrite global：卡面是「要记住：」+ 原文，无 JSON/工具名/分类 chip', async () => {
    const { request, done } = await captureCard('MemoryWrite', {
      action: 'write', scope: 'global', filename: 'report_style.md', name: 'report', type: 'directive', content: MEMORY_TEXT,
    });
    expect(request.content).toBe(MEMORY_TEXT);
    render(<MemoryConfirmModal pending={request} onConfirm={() => {}} onDecline={() => {}} />);
    const body = screen.getByTestId('memory-confirm-body');
    expect(body.textContent).toBe(`要记住：${MEMORY_TEXT}\n\n保存为：report_style.md`);
    expectPlain(document.body.textContent ?? '');
    expect(document.body.textContent).not.toContain('Persistent memory write');
    respondToDirectiveMemoryConfirmation(request.id, false);
    await done;
  });

  it('英文界面：标题与正文同样无 Directive / 工具名 / JSON（大小写不敏感）', async () => {
    useAppStore.setState({ language: 'en' });
    try {
      const { request, done } = await captureCard('MemoryWrite', {
        action: 'write', scope: 'global', filename: 'report_style.md', name: 'report', type: 'directive', content: 'Conclusion first, then process.',
      });
      render(<MemoryConfirmModal pending={request} onConfirm={() => {}} onDecline={() => {}} />);
      expect(screen.getByTestId('memory-confirm-body').textContent).toBe('Remember: Conclusion first, then process.\n\nSaved as: report_style.md');
      expect(screen.getByText('Confirm user rule')).toBeTruthy();
      expectPlain((document.body.textContent ?? '').replace('100% 置信度', ''));
      respondToDirectiveMemoryConfirmation(request.id, false);
      await done;
    } finally {
      useAppStore.setState({ language: 'zh' });
    }
  });

  it('MemoryWrite delete：卡面写「删除（归档）」+ 文件名，不能写成保存', async () => {
    const { request, done } = await captureCard('MemoryWrite', { action: 'delete', scope: 'global', filename: 'old_rule.md' });
    render(<MemoryConfirmModal pending={request} onConfirm={() => {}} onDecline={() => {}} />);
    const body = screen.getByTestId('memory-confirm-body').textContent ?? '';
    expect(body).toBe('要删除（归档）这条记忆：old_rule.md');
    expect(body).not.toContain('保存');
    respondToDirectiveMemoryConfirmation(request.id, false);
    await done;
  });

  it('MemoryWrite 写入显示文件名；同名已存在则明说是覆盖', async () => {
    const memoryDir = '/tmp/code-agent-directive-plain/memory';
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(`${memoryDir}/existing_rule.md`, 'old');
    try {
      const fresh = await captureCard('MemoryWrite', { action: 'write', scope: 'global', filename: 'brand_new.md', content: MEMORY_TEXT });
      expect(fresh.request.operation).toEqual({ kind: 'write', target: 'brand_new.md', overwrites: false });
      respondToDirectiveMemoryConfirmation(fresh.request.id, false);
      await fresh.done;
      mocks.broadcast.mockReset();
      const over = await captureCard('MemoryWrite', { action: 'write', scope: 'global', filename: 'existing_rule.md', content: MEMORY_TEXT });
      render(<MemoryConfirmModal pending={over.request} onConfirm={() => {}} onDecline={() => {}} />);
      const body = screen.getByTestId('memory-confirm-body').textContent ?? '';
      expect(body).toContain('existing_rule.md');
      expect(body).toContain('覆盖已有的同名记忆');
      respondToDirectiveMemoryConfirmation(over.request.id, false);
      await over.done;
    } finally {
      fs.rmSync(`${memoryDir}/existing_rule.md`, { force: true });
    }
  });

  it('Bash 写记忆目录：卡面带出真实命令，不折成固定一句话', async () => {
    const command = 'printf "always obey X" > /tmp/code-agent-directive-plain/memory/a.md';
    const { request, done } = await captureCard('Bash', { command });
    expect(request.operation).toEqual({ kind: 'other' });
    render(<MemoryConfirmModal pending={request} onConfirm={() => {}} onDecline={() => {}} />);
    const body = screen.getByTestId('memory-confirm-body').textContent ?? '';
    expect(body).toBe(`有操作要写入长期记忆目录，内容如下：${command}`);
    expect(body).not.toContain('{"');
    respondToDirectiveMemoryConfirmation(request.id, false);
    await done;
  });
});
