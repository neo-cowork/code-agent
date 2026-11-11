// @vitest-environment jsdom
// ============================================================================
// E2 · 轮内明细「读取了 <路径>」行可点进右栏预览
// ============================================================================
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgentFailureCode, HostReasonCode, type ToolCall } from '../../../src/shared/contract';

const openPreview = vi.hoisted(() => vi.fn());
const openSettingsTab = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (s: { openPreview: typeof openPreview; openSettingsTab: typeof openSettingsTab }) => unknown) =>
    selector({ openPreview, openSettingsTab }),
}));
vi.mock('../../../src/renderer/utils/featureFlags', () => ({
  isSemanticToolUIEnabled: () => false,
}));

// 真实 ToolExecutor 的宿主依赖静音（同 toolDetailsPermissionDenyCopy.test.tsx 的先例）。
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { ToolHeader } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolHeader';
import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';
import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { ToolExecutionResult } from '../../../src/host/tools/types';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';

function readCall(path: string): ToolCall {
  return {
    id: 'tc-read-1',
    name: 'Read',
    arguments: { file_path: path },
    result: {
      toolCallId: 'tc-read-1',
      success: true,
      output: 'file body',
    },
  } as ToolCall;
}

beforeEach(() => {
  openPreview.mockReset();
});

afterEach(cleanup);

describe('ToolHeader — Read path opens preview', () => {
  it('clicking the path control calls openPreview with the full path', () => {
    const path = '/Users/me/project/docs/report.md';
    render(<ToolHeader toolCall={readCall(path)} status="success" />);
    // 主行必须是人话，不能出现裸工具名
    expect(screen.getByText(/读取了/)).toBeTruthy();
    expect(screen.queryByText(/^Read$/)).toBeNull();

    const pathBtn = screen.getByTestId('tool-header-open-preview');
    fireEvent.click(pathBtn);
    expect(openPreview).toHaveBeenCalledWith(path);
  });

  it.each([
    ['Write', '未写入'],
    ['Edit', '未修改'],
    ['Read', '未读取'],
    ['Bash', '未执行'],
  ])('permission-blocked %s title is plain text and never opens preview', (name, verb) => {
    const toolCall = readCall('/tmp/neo-deny-notes.md');
    toolCall.name = name;
    toolCall.result = {
      toolCallId: toolCall.id,
      success: false,
      metadata: {
        hostReason: { code: HostReasonCode.PermissionDeniedScripted },
        failureCode: AgentFailureCode.PermissionDenied,
      },
    };

    render(<ToolHeader toolCall={toolCall} status="error" />);
    expect(screen.queryByTestId('tool-header-open-preview')).toBeNull();
    const title = screen.getByText(new RegExp(`^${verb}`));
    expect(title.tagName).toBe('SPAN');
    fireEvent.click(title);
    expect(openPreview).not.toHaveBeenCalled();
  });

  it('a completed Write title still opens its file preview', () => {
    const path = '/tmp/meeting-summary.md';
    const toolCall = readCall(path);
    toolCall.name = 'Write';
    render(<ToolHeader toolCall={toolCall} status="success" />);
    fireEvent.click(screen.getByTestId('tool-header-open-preview'));
    expect(openPreview).toHaveBeenCalledExactlyOnceWith(path);
  });

  it('TaskManager main line never shows the internal tool name', () => {
    const toolCall = {
      id: 'tc-tm',
      name: 'TaskManager',
      arguments: { action: 'list' },
    } as ToolCall;
    render(<ToolHeader toolCall={toolCall} status="success" />);
    expect(screen.getByText('更新了任务')).toBeTruthy();
    expect(screen.queryByText(/TaskManager/i)).toBeNull();
  });

  it('interrupted placeholder tooltip only contains a human status and display path', () => {
    const path = '/Users/me/project/docs/要点笔记.md';
    const toolCall = readCall(path);
    toolCall.result = {
      toolCallId: toolCall.id,
      success: false,
      error: '[no result: this tool call was cancelled before a result was recorded; do not assume it ran or succeeded]',
    };

    render(<ToolHeader toolCall={toolCall} status="error" />);
    const title = screen.getByTestId('tool-header-open-preview').getAttribute('title');
    expect(title).toBe('已中断 · …/docs/要点笔记.md');
    expect(title).not.toContain('[no result');
    expect(title).not.toContain('cancelled before');
  });
});

// ============================================================================
// 用户 deny 规则硬拒（真实 ToolExecutor，N-FIX-PREFLIGHT-UNWRITTEN-TITLE-OPEN-PREVIEW-FAIL-FU1）：
// 这类行 metadata 里只有 hostReason（PERMISSION_DENIED_USER_RULE），没有 failureCode。
// 修复前 classifier 不认它 → 标题仍是「打开预览」按钮 → 点开一个从未写出的文件，
// 右栏红字「failed to load file」。metadata 形状不手写——直接跑真实 executor 拿
// 硬拒结果喂 ToolHeader / ToolDetails（同 toolDetailsPermissionDenyCopy 的夹具先例）。
// ============================================================================
describe('ToolHeader/ToolDetails — user deny rule (real executor)', () => {
  let workspace: string;
  let denyResult: ToolExecutionResult;
  const notesName = 'notes.md';
  const notesArgs = () => ({ file_path: path.join(workspace, notesName), content: '# 本周报告' });

  const asToolCall = (result: ToolExecutionResult): ToolCall =>
    ({ id: 'tc-deny-write', name: 'Write', arguments: notesArgs(), result }) as unknown as ToolCall;

  const makeExecutor = (requestPermission: () => Promise<boolean>) => {
    const executor = new ToolExecutor({ workingDirectory: workspace, requestPermission });
    executor.setAuditEnabled(false);
    return executor;
  };

  beforeAll(() => {
    getProtocolRegistry();
  });
  beforeEach(async () => {
    resetPolicyEngine();
    resetPermissionModeManager();
    getToolCache().clear();
    getPolicyEngine().loadUserRules({ deny: ['Write'] }, 'user-ui');
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-click-deny-'));
    // 审批回调一叫就炸：用户 deny 规则是硬拒，必须发生在审批之前。
    denyResult = await makeExecutor(async () => {
      throw new Error('硬拒发生在审批之前，审批回调不该被叫起');
    }).execute('Write', notesArgs(), { sessionId: 'preview-click-deny' });
  });
  afterEach(async () => {
    resetPolicyEngine();
    resetPermissionModeManager();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('denied Write 的标题是「未写入 · notes.md」纯文本，点击不打开预览', () => {
    expect(denyResult.success).toBe(false);
    expect(denyResult.metadata?.hostReason).toMatchObject({ code: HostReasonCode.PermissionDeniedUserRule });
    // 真实证据：deny 发生在写盘之前，文件从未写出。
    expect(existsSync(path.join(workspace, notesName))).toBe(false);

    render(<ToolHeader toolCall={asToolCall(denyResult)} status="error" />);
    expect(screen.queryByTestId('tool-header-open-preview')).toBeNull();
    const title = screen.getByText(/^未写入 · /);
    expect(title.textContent).toBe('未写入 · notes.md');
    expect(title.tagName).toBe('SPAN');
    fireEvent.click(title);
    expect(openPreview).not.toHaveBeenCalled();
  });

  it('明细卡仍是权限规则登记文案，不是「需要人工确认」', () => {
    render(<ToolDetails toolCall={asToolCall(denyResult)} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('被你设置的权限规则拦下了，没有执行');
    expect(text).toContain('用户级权限规则');
    // approvalRequired 的 preflight reason（「这一步需要人工确认…」）不许顶掉登记文案；
    // 模型可见的英文原句也不许漏到卡上。
    expect(text).not.toContain('需要人工确认');
    expect(text).not.toContain('Blocked by your permission deny rule');
  });

  it('同一路径成功 Write 后标题仍是打开预览按钮并带全路径', async () => {
    // 用户删掉 deny 规则后重试同一文件：真实写盘成功。
    resetPolicyEngine();
    const okResult = await makeExecutor(async () => true)
      .execute('Write', notesArgs(), { sessionId: 'preview-click-deny' });
    expect(okResult.success).toBe(true);
    expect(existsSync(path.join(workspace, notesName))).toBe(true);

    render(<ToolHeader toolCall={asToolCall(okResult)} status="success" />);
    fireEvent.click(screen.getByTestId('tool-header-open-preview'));
    expect(openPreview).toHaveBeenCalledWith(path.join(workspace, notesName));
  });
});
