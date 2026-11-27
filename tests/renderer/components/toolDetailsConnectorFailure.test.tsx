import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@shared/contract';
import { createHostReason, HostReasonCode } from '@shared/contract';
import type { TraceNode } from '@shared/contract/trace';
import type { CanUseToolFn, Logger, ToolContext, ToolResult } from '../../../src/host/protocol/tools';
import { zh, en } from '../../../src/renderer/i18n';

const i18nState: { lang: 'zh' | 'en' } = { lang: 'zh' };

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: i18nState.lang === 'zh' ? zh : en,
    language: i18nState.lang,
  }),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (s: { openPreview: () => void; openSettingsTab: () => void }) => unknown) =>
    selector({ openPreview: () => undefined, openSettingsTab: () => undefined }),
}));

const execMock = vi.fn();
const getMock = vi.fn();

vi.mock('../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({
    get: getMock,
  }),
}));

import { mailModule } from '../../../src/host/tools/modules/connectors/mail';
import { remindersCreateModule } from '../../../src/host/tools/modules/connectors/remindersCreate';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';
import { humanizeToolFailureReason } from '../../../src/renderer/utils/toolExecutionPresentation';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'connector-failure-card-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => undefined,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

function decodeHtml(markup: string): string {
  return markup.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

function fromHostResult(
  id: string,
  name: string,
  args: Record<string, unknown>,
  res: ToolResult<string>,
): { toolCall: ToolCall; traceNode: TraceNode } {
  const metadata: Record<string, unknown> = {
    ...(res.meta ?? {}),
    ...(!res.ok && res.code ? { code: res.code } : {}),
  };
  const error = res.ok ? undefined : res.error;
  const userMessage = res.ok ? undefined : res.userMessage;
  const toolCall: ToolCall = {
    id,
    name,
    arguments: args,
    result: {
      toolCallId: id,
      success: res.ok,
      error,
      ...(userMessage !== undefined ? { userMessage } : {}),
      metadata,
    },
  };
  const traceNode: TraceNode = {
    id,
    messageId: 'msg-connector-1',
    type: 'tool_call',
    content: '',
    timestamp: Date.now(),
    toolCall: {
      id,
      name,
      args,
      result: error,
      userMessage,
      success: res.ok,
      duration: 18,
      metadata,
    },
  };
  return { toolCall, traceNode };
}

describe('Connector failure cards (real executeMail / executeRemindersCreate shapes)', () => {
  beforeEach(() => {
    i18nState.lang = 'zh';
    execMock.mockReset();
    getMock.mockReset();
    getMock.mockReturnValue({ execute: execMock });
  });

  afterEach(() => {
    i18nState.lang = 'zh';
  });

  it('mail not_authorized shows authorization reason on folded ToolStepGroup, ToolCallDisplay, and ToolDetails in zh and en', async () => {
    const deniedErr = Object.assign(
      new Error('Command failed: osascript -e \'tell application "Mail" to get name of every account\''),
      { stderr: 'execution error: Not authorized to send Apple events to Mail. (-1743)' },
    );
    execMock.mockRejectedValueOnce(deniedErr);
    const handler = await mailModule.createHandler();
    const res = await handler.execute({ action: 'list_messages', limit: 3 }, makeCtx(), allowAll);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('not_authorized');

    const { toolCall, traceNode } = fromHostResult('tc-mail-auth', 'mail', { action: 'list_messages', limit: 3 }, res);

    // zh
    i18nState.lang = 'zh';
    const expectedZh = zh.toolStepHumanize.connectorFailureCodes.not_authorized.mail.folded;
    expect(humanizeToolFailureReason(toolCall, zh)).toBe(expectedZh);
    const groupZh = decodeHtml(renderToStaticMarkup(React.createElement(ToolStepGroup, { nodes: [traceNode] })));
    expect(groupZh).toContain(expectedZh);
    expect(groupZh).not.toContain(zh.toolStepHumanize.failureReasonMissing);
    expect(groupZh).not.toContain(zh.toolStepHumanize.rawFailureCodeFallback);
    expect(groupZh).not.toMatch(/osascript|-1743|not_authorized/i);

    const cardZh = decodeHtml(renderToStaticMarkup(React.createElement(ToolCallDisplay, { toolCall, index: 0, total: 1 })));
    expect(cardZh).toContain(expectedZh);

    const detailsZh = decodeHtml(renderToStaticMarkup(React.createElement(ToolDetails, { toolCall })));
    expect(detailsZh).toContain(zh.toolStepHumanize.connectorFailureCodes.not_authorized.mail.summary);
    expect(detailsZh).toContain(zh.toolStepHumanize.connectorFailureCodes.not_authorized.mail.detail);
    expect(detailsZh).toContain('data-testid="tool-raw-error-toggle"');
    expect(detailsZh).toContain('text-zinc-300');
    expect(detailsZh).not.toContain('text-zinc-500 transition-colors');

    // en
    i18nState.lang = 'en';
    const expectedEn = en.toolStepHumanize.connectorFailureCodes.not_authorized.mail.folded;
    expect(humanizeToolFailureReason(toolCall, en)).toBe(expectedEn);
    const groupEn = decodeHtml(renderToStaticMarkup(React.createElement(ToolStepGroup, { nodes: [traceNode] })));
    expect(groupEn).toContain(expectedEn);
    expect(groupEn).not.toMatch(/[\u4e00-\u9fff]/);
    expect(groupEn).not.toContain(en.toolStepHumanize.failureReasonMissing);
    expect(groupEn).not.toContain(en.toolStepHumanize.rawFailureCodeFallback);
  });

  it('mail not_found (non-existent mailbox) shows concrete reason when folded in zh and en', async () => {
    const notFoundErr = Object.assign(
      new Error('Command failed: osascript -e \'tell application "Mail" to get mailbox "Nope"\''),
      { stderr: 'execution error: Mail got an error: Can’t get mailbox "Nope". (-1728)' },
    );
    execMock.mockRejectedValueOnce(notFoundErr);
    const handler = await mailModule.createHandler();
    const res = await handler.execute({ action: 'list_messages', mailbox: 'Nope', limit: 3 }, makeCtx(), allowAll);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('not_found');

    const { toolCall, traceNode } = fromHostResult(
      'tc-mail-not-found',
      'mail',
      { action: 'list_messages', mailbox: 'Nope', limit: 3 },
      res,
    );

    i18nState.lang = 'zh';
    const groupZh = renderToStaticMarkup(React.createElement(ToolStepGroup, { nodes: [traceNode] }));
    expect(groupZh).toContain(zh.toolStepHumanize.connectorFailureCodes.not_found.mail.folded);
    expect(groupZh).not.toContain(zh.toolStepHumanize.rawFailureCodeFallback);
    expect(groupZh).not.toContain(zh.toolStepHumanize.failureReasonMissing);

    i18nState.lang = 'en';
    const groupEn = renderToStaticMarkup(React.createElement(ToolStepGroup, { nodes: [traceNode] }));
    expect(groupEn).toContain(en.toolStepHumanize.connectorFailureCodes.not_found.mail.folded);
    expect(groupEn).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('reminders_create with unknown list emits not_found and shows concrete reason when folded', async () => {
    execMock.mockRejectedValueOnce(
      Object.assign(
        new Error('No reminder list named "不存在的清单". Available lists: Reminders. Omit list to use the default list.'),
        { code: 'not_found' },
      ),
    );
    const handler = await remindersCreateModule.createHandler();
    const res = await handler.execute({ list: '不存在的清单', title: '核对季度账单' }, makeCtx(), allowAll);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('not_found');

    const { traceNode } = fromHostResult(
      'tc-rem-unknown-list',
      'reminders_create',
      { list: '不存在的清单', title: '核对季度账单' },
      res,
    );

    i18nState.lang = 'zh';
    const groupZh = renderToStaticMarkup(React.createElement(ToolStepGroup, { nodes: [traceNode] }));
    expect(groupZh).toContain(zh.toolStepHumanize.connectorFailureCodes.not_found.reminders.folded);
    expect(groupZh).not.toContain(zh.toolStepHumanize.failureReasonMissing);
    expect(groupZh).not.toContain(zh.toolStepHumanize.rawFailureCodeFallback);

    i18nState.lang = 'en';
    const groupEn = renderToStaticMarkup(React.createElement(ToolStepGroup, { nodes: [traceNode] }));
    expect(groupEn).toContain(en.toolStepHumanize.connectorFailureCodes.not_found.reminders.folded);
    expect(groupEn).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('permission-rule-denied Write shows concrete permission-rule reason when folded in zh and en', () => {
    const metadata = {
      hostReason: createHostReason(
        HostReasonCode.PermissionDeniedUserRule,
        'Blocked by your permission deny rule (User deny: Write).',
        { toolName: 'Write' },
      ),
    };
    const traceNode: TraceNode = {
      id: 'tc-write-denied',
      messageId: 'msg-perm-1',
      type: 'tool_call',
      content: '',
      timestamp: Date.now(),
      toolCall: {
        id: 'tc-write-denied',
        name: 'Write',
        args: { file_path: '/tmp/protected-report.md', content: 'x' },
        result: 'Blocked by your permission deny rule (User deny: Write).',
        success: false,
        duration: 4,
        metadata,
      },
    };

    i18nState.lang = 'zh';
    const groupZh = renderToStaticMarkup(React.createElement(ToolStepGroup, { nodes: [traceNode] }));
    expect(groupZh).toContain('用户级权限规则');
    expect(groupZh).not.toContain(zh.toolStepHumanize.failureReasonMissing);
    expect(groupZh).not.toContain('Blocked by your permission deny rule');

    i18nState.lang = 'en';
    const groupEn = renderToStaticMarkup(React.createElement(ToolStepGroup, { nodes: [traceNode] }));
    expect(groupEn).toContain('User-level permission rules');
    expect(groupEn).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
