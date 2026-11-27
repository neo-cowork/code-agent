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
const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: i18nState.language === 'en' ? en : zh, language: i18nState.language }) };
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
    i18nState.language = 'zh';
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
      // 工作区外的目标留完整位置（路径显示口径由 N-FIX-ABS-PATH-DISPLAY-SYSTEMIC 统一，本单不改）。
      expect(screen.getByTestId('permission-consequence').textContent).toBe('将在工作区外新建 /Users/example/Documents/contract-notes.md（约 1 个文件）。');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    [internalWrite, 1],
    [externalWrite, 1],
    [dangerousCommand, 1],
    [{ ...internalWrite, tool: 'Read', type: 'file_read' as const }, 0],
    [{ ...internalWrite, tool: 'Read', type: 'file_read' as const, boundary: { id: 'file.external_read' as const } }, 1],
    [{ ...internalWrite, tool: 'Bash', type: 'command' as const, details: { command: 'ls reports', commandRiskLevel: 'medium' as const } }, 0],
    [{ ...mcpRequest, details: { connectorAccess: { connectorId: 'lark', connectorName: '飞书', access: 'write' as const } } }, 1],
    [{ ...mcpRequest, details: { method: 'POST', url: 'https://example.com' } }, 1],
    [{ ...mcpRequest, details: { method: 'GET', url: 'https://example.com' } }, 0],
  ])('face consequence count: %j => %i', (request, count) => {
    renderRequest(request);
    expect(screen.queryAllByTestId('permission-consequence')).toHaveLength(count);
    // 高危命令卡默认展开，没有折叠开关。
    const toggle = screen.queryByRole('button', { name: '更多选项与详情' });
    if (toggle) fireEvent.click(toggle);
    expect(screen.queryAllByTestId('permission-consequence')).toHaveLength(count);
  });

  it('outside-workspace read names the boundary in the question and keeps one consequence line', () => {
    renderRequest({ ...internalWrite, tool: 'Read', type: 'file_read' as const, details: { path: '/Users/x/.ssh/id_rsa' }, boundary: { id: 'file.external_read' as const } });
    expect(screen.getByText('允许读取 id_rsa（工作区外）？')).toBeTruthy();
    expect(screen.getAllByTestId('permission-consequence')).toHaveLength(1);
  });

  it('external write keeps safe primary response and the outside-workspace qualifier in the question', async () => {
    renderRequest(externalWrite);
    expect(screen.getByText('允许写入 report.md（工作区外）？')).toBeTruthy();
    expect(screen.getByTestId('permission-consequence').textContent).toContain('工作区外');
    const reject = screen.getByRole('button', { name: '暂不' });
    expect(reject.className).toContain('from-primary-800');
    expect(screen.getByRole('button', { name: '允许' }).className).toContain('border-red-500/50');
    expect(document.activeElement).toBe(reject);
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agent:permission-response', externalWrite.id, 'deny', externalWrite.sessionId));
  });

  // N-FIX-EN-APPROVAL-QUESTION-FULLWIDTH-PAREN-OUTSIDE-WORKSPACE（FB-1982）：英文卡
  // 工作区外限定语必须是半角括号且文件名后带一个空格，标题/后果行不得混入中文标点。
  it('en 工作区外 Write 问句用半角括号加空格，标题与后果行无中文标点', () => {
    i18nState.language = 'en';
    renderRequest(externalWrite);

    expect(screen.getByText('Allow writing report.md (outside workspace)?')).toBeTruthy();
    expect(screen.getByText('Write file')).toBeTruthy();
    const consequence = screen.getByTestId('permission-consequence').textContent ?? '';
    expect(consequence).toBe('Writes /Users/me/Documents/report.md outside the workspace (1 file) and may overwrite existing content.');
    expect(consequence).not.toMatch(/[\u3000-\u303F\uFF00-\uFFEF]/u);
    expect(screen.queryByText('允许写入 report.md（工作区外）？')).toBeNull();
  });

  it.each([undefined, 'device'] as const)('/dev/null 标题用完整路径；设备警告只信宿主 targetKind: %s', (targetKind) => {
    renderRequest({ ...deviceNullEdit, details: { ...deviceNullEdit.details, targetKind } });
    expect(screen.getByText('允许编辑 /dev/null（工作区外）？')).toBeTruthy();
    expect(screen.queryByText('允许编辑 null（工作区外）？')).toBeNull();
    const text = screen.getByTestId('permission-consequence').textContent;
    if (targetKind === 'device') expect(text).toBe('将向工作区外的设备文件 /dev/null 写入；原子写入会替换该设备节点本身。');
    else { expect(text).toContain('可能覆盖现有内容'); expect(text).not.toContain('设备文件'); }
  });

  it('dangerous deletion command has one consequence, a danger badge, the visible command and safe primary', () => {
    renderRequest(dangerousCommand);
    expect(screen.getByTestId('permission-consequence').textContent).toBe('将永久删除 /workspace/dist（约 312 个文件），不进回收站。');
    expect(screen.getByText('危险')).toBeTruthy();
    expect(screen.getByTestId('permission-card').innerHTML).toContain('rm -rf ./dist');
    expect(screen.getByRole('button', { name: '暂不' }).className).toContain('from-primary-800');
    expect(screen.getByRole('button', { name: '允许' }).className).toContain('border-red-500/50');
    expect(screen.getByTestId('permission-card').firstElementChild?.className).toContain('border-red-500');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(invoke).not.toHaveBeenCalled();
  });

  // #1611：推到 Git 远端是外发，读凭据路径是隐私——卡收起和展开时都要看得到这句，且只出现一次。
  it.each([
    ['git push origin feature-x', 'B1: git_remote_or_credential_write', '命令将写入 Git 远端或远端/凭据配置，需要你确认。'],
    ['cat ~/.aws/credentials', 'B1: sensitive_credential_read', '命令将读取可能包含凭据的路径，需要你确认。'],
  ] as const)('classifier-named command %s keeps its consequence on the face', (command, rule, copy) => {
    renderRequest({
      ...internalWrite, type: 'command', tool: 'Bash',
      details: { command, commandRiskLevel: 'medium' },
      decisionTrace: {
        toolName: 'Bash', finalOutcome: 'ask', totalDurationMs: 0,
        steps: [{ timestamp: 1, layer: 'permission_classifier', rule, result: 'ask', reason: 'guard', durationMs: 0 }],
      },
    });
    expect(screen.getByTestId('permission-card').firstElementChild?.getAttribute('data-view-mode')).toBe('compact');
    expect(screen.getByTestId('permission-card-face').textContent).toContain(copy);
    fireEvent.click(screen.getByRole('button', { name: '更多选项与详情' }));
    expect(screen.getAllByTestId('permission-consequence')).toHaveLength(1);
    expect(screen.getByTestId('permission-consequence').textContent).toBe(copy);
  });

  // 网页上接受确认框是 dangerous_command + browser_action.*：后果行必须是网页那句，不能套「高风险命令」。
  it('a web dialog accept keeps the web consequence, never the command one', () => {
    renderRequest({
      ...internalWrite, tool: 'browser_action.handle_dialog', type: 'dangerous_command', dangerLevel: 'danger',
      forceConfirm: true, details: { action: 'handle_dialog' }, boundary: undefined,
    });
    const text = screen.getByTestId('permission-card').textContent ?? '';
    expect(text).toContain('将在网页上点击或输入，可能会提交内容。');
    expect(text).not.toContain('高风险命令');
    expect(screen.getAllByTestId('permission-consequence')).toHaveLength(1);
  });

  it('MCP server / tool 只在展开的详情里出现，卡头和卡面不露协议工具原名', () => {
    renderRequest(mcpRequest);
    const card = screen.getByTestId('permission-card').firstElementChild as HTMLElement;
    expect(screen.getByText('允许调用这个外部工具？')).toBeTruthy();
    expect(document.body.textContent).not.toContain('MCPUnified');
    expect(document.body.textContent).not.toContain('lark-prod');
    expect(document.body.textContent).not.toContain('docs.search');
    fireEvent.click(screen.getByRole('button', { name: '更多选项与详情' }));
    expect(screen.getByText('lark-prod / docs.search')).toBeTruthy();
    expect((card.firstElementChild as HTMLElement).textContent).not.toContain('MCPUnified');
    expect(screen.getByTestId('permission-card-face').textContent).not.toContain('lark-prod');
  });

  it.each(['medium', 'unknown'] as const)('routine %s risk has a normal card', (commandRiskLevel) => {
    renderRequest({ ...internalWrite, type: 'command', tool: 'Bash', details: { command: 'mv draft.md notes.md', commandRiskLevel } });
    expect(screen.getByTestId('permission-card').firstElementChild?.className).not.toContain('border-red-500');
    expect(screen.getByRole('button', { name: '允许' }).className).not.toContain('border-red-500');
    expect(screen.queryByTestId('permission-consequence')).toBeNull();
  });
});
