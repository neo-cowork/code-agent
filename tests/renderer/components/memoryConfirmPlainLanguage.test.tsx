// @vitest-environment jsdom
// 全局记忆确认卡：真 ToolExecutor 门 → 真 requestDirectiveMemoryConfirmation 广播 → MemoryConfirmModal。
// 卡面只能是一句人话，不得出现 JSON / 工具名 / directive / 英文分类串。
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
    expect(text).not.toContain(raw);
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
    expect(body.textContent).toBe(`要记住：${MEMORY_TEXT}`);
    expectPlain(document.body.textContent ?? '');
    expect(document.body.textContent).not.toContain('Persistent memory write');
    respondToDirectiveMemoryConfirmation(request.id, false);
    await done;
  });

  it('Bash 写记忆目录：内容为空 → 通用一句人话，不露命令或工具名', async () => {
    const { request, done } = await captureCard('Bash', { command: 'printf x > /tmp/code-agent-directive-plain/memory/a.md' });
    expect(request.content).toBe('');
    render(<MemoryConfirmModal pending={request} onConfirm={() => {}} onDecline={() => {}} />);
    expect(screen.getByTestId('memory-confirm-body').textContent).toBe('要把一条长期规则保存到记忆里。');
    expectPlain(document.body.textContent ?? '');
    expect(document.body.textContent).not.toContain('printf');
    respondToDirectiveMemoryConfirmation(request.id, false);
    await done;
  });
});
