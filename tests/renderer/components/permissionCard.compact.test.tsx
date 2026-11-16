// @vitest-environment jsdom
import React from 'react';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFileTargetKind } from '../../../src/host/permissions/fileTargetKind';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: null,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
    developerMode: false,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

const internalWrite: PermissionRequest = {
  id: 'permission-internal-write',
  sessionId: 'request-session',
  tool: 'Write',
  type: 'file_write',
  details: { path: '/workspace/reports/report.md' },
  boundary: { id: 'file.project_write' },
  timestamp: 1,
};

const externalWrite: PermissionRequest = {
  ...internalWrite,
  id: 'permission-external-write',
  details: { path: '/Users/me/Documents/report.md' },
  boundary: { id: 'file.external_write' },
};

const dangerousCommand: PermissionRequest = {
  id: 'permission-danger-command',
  sessionId: 'request-session',
  tool: 'Bash',
  type: 'dangerous_command',
  dangerLevel: 'danger',
  details: {
    command: 'rm -rf ./dist',
    commandRiskLevel: 'high',
    commandSecurityFlags: ['recursive_delete_targeted'],
    affectedPath: '/workspace/dist',
    affectedFileCount: 312,
  },
  boundary: { id: 'command.shell' },
  timestamp: 1,
};

const mcpRequest: PermissionRequest = {
  id: 'permission-mcp',
  sessionId: 'request-session',
  tool: 'MCPUnified',
  type: 'network',
  details: { server: 'lark-prod', toolName: 'docs.search' },
  boundary: { id: 'mcp.server_tool' },
  timestamp: 1,
};

const deviceNullEdit: PermissionRequest = {
  ...internalWrite,
  id: 'permission-dev-null',
  tool: 'Edit',
  type: 'file_edit',
  details: { path: '/dev/null' },
  boundary: { id: 'file.external_write' },
};

function renderRequest(request: PermissionRequest) {
  return render(
    <PermissionCard
      requestOverride={request}
      sessionIdOverride="session-current"
    />,
  );
}

describe('PermissionCard quiet face', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    for (const request of [internalWrite, externalWrite, dangerousCommand, mcpRequest, deviceNullEdit]) releaseApprovalResponse(request.id);
  });

  it.each([
    { ...internalWrite, tool: 'Bash', type: 'command' as const, details: { command: 'cat contract.txt > contract-notes.md' } },
    internalWrite,
    { ...internalWrite, type: 'file_delete' as const, tool: 'Delete' },
  ])('face has one question, quote and exactly two actions: $type', (request) => {
    const command = 'cat contract.txt > contract-notes.md';
    renderRequest({ ...request, details: { ...request.details, command, userRequest: { text: 'Save the contract key points', truncated: false }, sandbox: { applied: true, code: 'OS_SANDBOX_APPLIED' } } });
    const card = screen.getByTestId('permission-card');
    expect(card.firstElementChild?.getAttribute('data-view-mode')).toBe('compact');
    const face = screen.getByTestId('permission-card-face');
    expect(within(face).getByText(/允许.*？/)).toBeTruthy();
    expect(within(face).getByTestId('user-request-quote').textContent).toContain('Save the contract key points');
    expect(within(face).getAllByRole('button').map((button) => button.textContent)).toEqual(['允许', '暂不']);
    expect(card.textContent).not.toMatch(/cat contract|危险|沙箱|sandbox|工作区外|y\/n/);
    expect(card.querySelector('kbd')).toBeNull();
    const toggle = screen.getByRole('button', { name: '更多选项与详情' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByText(command)).toBeTruthy();
    expect(screen.getByRole('button', { name: /本次任务内允许/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /24 小时内允许/ })).toBeTruthy();
    expect(screen.getByTestId('permission-sandbox-status')).toBeTruthy();
    expect(screen.getByText(command).getAttribute('title')).toBeNull();
    expect(screen.getByText(command).className).toContain('max-h-48');
    expect(screen.getByText(command).className).toContain('overflow-y-auto');
    expect(screen.getByRole('button', { name: '收起▴' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '收起▴' }));
    expect(screen.queryByText(command)).toBeNull();
    expect(screen.getByTestId('user-request-quote')).toBeTruthy();
  });

  it('host stat proves new workspace file has no consequence; existing/outside keep one without internal paths', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'quiet-new-file-'));
    const target = path.join(dir, 'contract-notes.md');
    const quoted = { text: 'Save the contract key points', truncated: false };
    try {
      const fresh = renderRequest({ ...internalWrite, details: { path: target, targetKind: resolveFileTargetKind(target), userRequest: quoted } });
      expect(screen.queryAllByTestId('permission-consequence')).toHaveLength(0);
      expect(screen.getByTestId('permission-card-face').textContent).not.toContain('/Users/');
      expect(screen.getByTestId('permission-card-face').textContent).toContain('允许写入 contract-notes.md？');
      expect(screen.getByTestId('user-request-quote').textContent).toContain(quoted.text);
      expect(within(screen.getByTestId('permission-card-face')).getAllByRole('button')).toHaveLength(2);
      fresh.unmount();
      writeFileSync(target, 'Existing notes');
      const existing = renderRequest({ ...internalWrite, details: { path: target, targetKind: resolveFileTargetKind(target) } });
      expect(screen.getAllByTestId('permission-consequence')).toHaveLength(1);
      expect(screen.getByTestId('permission-consequence').textContent).toContain('contract-notes.md');
      expect(screen.getByTestId('permission-card-face').textContent).not.toContain(dir);
      existing.unmount();
      renderRequest({ ...externalWrite, details: { path: '/Users/example/Documents/contract-notes.md', targetKind: 'absent' } });
      expect(screen.getAllByTestId('permission-consequence')).toHaveLength(1);
      expect(screen.getByTestId('permission-consequence').textContent).toContain('~/Documents/contract-notes.md');
      expect(screen.getByTestId('permission-card-face').textContent).not.toContain('/Users/');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    [internalWrite, 1],
    [externalWrite, 1],
    [dangerousCommand, 1],
    [{ ...internalWrite, tool: 'Read', type: 'file_read' as const }, 0],
    [{ ...internalWrite, tool: 'Read', type: 'file_read' as const, boundary: { id: 'file.external_read' as const } }, 0],
    [{ ...internalWrite, tool: 'Bash', type: 'command' as const, details: { command: 'ls reports', commandRiskLevel: 'medium' as const } }, 0],
    [{ ...mcpRequest, details: { connectorAccess: { connectorId: 'lark', connectorName: '飞书', access: 'write' as const } } }, 1],
    [{ ...mcpRequest, details: { method: 'POST', url: 'https://example.com' } }, 1],
    [{ ...mcpRequest, details: { method: 'GET', url: 'https://example.com' } }, 0],
  ])('face consequence count: %j => %i', (request, count) => {
    renderRequest(request);
    expect(screen.queryAllByTestId('permission-consequence')).toHaveLength(count);
    fireEvent.click(screen.getByRole('button', { name: '更多选项与详情' }));
    expect(screen.queryAllByTestId('permission-consequence')).toHaveLength(count);
  });

  it('external write keeps safe primary response and moves the qualifier out of the question', async () => {
    renderRequest(externalWrite);
    expect(screen.getByText('允许写入 report.md？')).toBeTruthy();
    expect(screen.getByTestId('permission-consequence').textContent).toContain('工作区外');
    const reject = screen.getByRole('button', { name: '暂不' });
    expect(reject.className).toContain('from-primary-800');
    expect(screen.getByRole('button', { name: '允许' }).className).toContain('border-red-500/50');
    expect(document.activeElement).toBe(reject);
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agent:permission-response', externalWrite.id, 'deny', externalWrite.sessionId));
  });

  it.each([undefined, 'device'] as const)('device warning trusts host targetKind: %s', (targetKind) => {
    renderRequest({ ...deviceNullEdit, details: { ...deviceNullEdit.details, targetKind } });
    expect(screen.getByText('允许编辑 /dev/null？')).toBeTruthy();
    const text = screen.getByTestId('permission-consequence').textContent;
    if (targetKind === 'device') expect(text).toBe('将向工作区外的设备文件 /dev/null 写入；原子写入会替换该设备节点本身。');
    else { expect(text).toContain('可能覆盖现有内容'); expect(text).not.toContain('设备文件'); }
  });

  it('deletion has one consequence and safe primary, but hides the raw command', () => {
    renderRequest(dangerousCommand);
    expect(screen.getByTestId('permission-consequence').textContent).toBe('将永久删除 dist（约 312 个文件），不进回收站。');
    expect(screen.queryByText('rm -rf ./dist')).toBeNull();
    expect(screen.getByRole('button', { name: '暂不' }).className).toContain('from-primary-800');
    expect(screen.getByRole('button', { name: '允许' }).className).toContain('border-red-500/50');
    expect(screen.getByTestId('permission-card').firstElementChild?.className).toContain('border-red-500');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['medium', 'unknown'] as const)('routine %s risk has a normal card', (commandRiskLevel) => {
    renderRequest({ ...internalWrite, type: 'command', tool: 'Bash', details: { command: 'mv draft.md notes.md', commandRiskLevel } });
    expect(screen.getByTestId('permission-card').firstElementChild?.className).not.toContain('border-red-500');
    expect(screen.getByRole('button', { name: '允许' }).className).not.toContain('border-red-500');
    expect(screen.queryByTestId('permission-consequence')).toBeNull();
  });
});
