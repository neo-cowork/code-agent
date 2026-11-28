// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract';
import type { PermissionRequest } from '../../../src/renderer/components/PermissionDialog/types';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { permissionSummary } from '../../../src/renderer/components/PermissionDialog/permissionPresentation';
import { describeApproval } from '../../../src/renderer/components/PermissionDialog/describeApproval';

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: i18nState.language === 'en' ? en : zh, language: i18nState.language }),
}));
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
  default: { isAvailable: () => true, invoke: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';

afterEach(() => {
  cleanup();
  i18nState.language = 'zh';
});

const mailDraftWithSubject: PermissionRequest = {
  id: 'perm-mail-draft-subject',
  sessionId: 'session-current',
  tool: 'mail_draft',
  type: 'command',
  details: {
    to: ['alice@example.com'],
    subject: '本周进度同步',
  },
  rawArgs: {
    to: ['alice@example.com'],
    subject: '本周进度同步',
    content: '附件是本周进度',
  },
  timestamp: 1,
};

const mailDraftContractRequest: ContractPermissionRequest = {
  id: 'perm-mail-draft-subject',
  sessionId: 'session-current',
  tool: 'mail_draft',
  type: 'command',
  details: {
    to: ['alice@example.com'],
    subject: '本周进度同步',
    content: '附件是本周进度',
  } as ContractPermissionRequest['details'],
  timestamp: 1,
};

const mailDraftRecipientOnly: PermissionRequest = {
  id: 'perm-mail-draft-to',
  sessionId: 'session-current',
  tool: 'mail_draft',
  type: 'command',
  details: {},
  rawArgs: {
    to: ['alice@example.com'],
  },
  timestamp: 2,
};

const mailDraftNoObject: PermissionRequest = {
  id: 'perm-mail-draft-empty',
  sessionId: 'session-current',
  tool: 'mail_draft',
  type: 'command',
  details: {},
  timestamp: 3,
};

const tmeetCreateWithSubject: PermissionRequest = {
  id: 'perm-tmeet-create',
  sessionId: 'session-current',
  tool: 'tmeetMeetingCreate',
  type: 'command',
  details: {},
  rawArgs: {
    subject: '产品评审',
  },
  timestamp: 4,
};

const feishuWriteWithArgsPreview: PermissionRequest = {
  id: 'perm-feishu-write',
  sessionId: 'session-current',
  tool: 'mcp__lark__calendar_v4_calendarEvent_create',
  type: 'command',
  details: {},
  argsPreview: '周会同步 · 10:00-11:00',
  timestamp: 5,
};

// 停车的事件回复：宿主把 replyText 写进 argsPreview（多段时以「 · 」拼接），正文里的逗号不是分段。
const parkedEventReplyWithFreeText: PermissionRequest = {
  id: 'perm-parked-event-reply',
  sessionId: 'session-current',
  tool: 'reply_to_event',
  type: 'network',
  details: {},
  argsPreview: 'Sure, see you at 10am tomorrow',
  timestamp: 8,
};

const unknownNetworkFallback: PermissionRequest = {
  id: 'perm-unknown-network',
  sessionId: 'session-current',
  tool: 'custom_unknown_tool',
  type: 'network',
  details: {},
  timestamp: 6,
};

const unknownGenericFallback: PermissionRequest = {
  id: 'perm-unknown-generic',
  sessionId: 'session-current',
  tool: 'custom_unknown_tool',
  type: 'command',
  details: {},
  timestamp: 7,
};

describe('compact approval bar action+object one-liner', () => {
  it.each<{
    name: string;
    request: PermissionRequest;
    zhExpected: string;
    enExpected: string;
  }>([
    {
      name: 'mail_draft with subject',
      request: mailDraftWithSubject,
      zhExpected: '保存邮件草稿「本周进度同步」？',
      enExpected: 'Save an email draft “本周进度同步”?',
    },
    {
      name: 'mail_draft with first recipient when subject missing',
      request: mailDraftRecipientOnly,
      zhExpected: '保存邮件草稿「alice@example.com」？',
      enExpected: 'Save an email draft “alice@example.com”?',
    },
    {
      name: 'mail_draft action-only when no object',
      request: mailDraftNoObject,
      zhExpected: '保存邮件草稿？',
      enExpected: 'Save an email draft?',
    },
    {
      name: 'CLI connector write tool (tmeetMeetingCreate) with subject',
      request: tmeetCreateWithSubject,
      zhExpected: '创建会议「产品评审」？',
      enExpected: 'Create a meeting “产品评审”?',
    },
    {
      name: 'Feishu connector write with argsPreview only (never exposes raw tool name)',
      request: feishuWriteWithArgsPreview,
      zhExpected: '允许对「周会同步」执行这项操作？',
      enExpected: 'Allow this operation on “周会同步”?',
    },
    {
      name: 'parked event reply keeps the commas of its free-text argsPreview',
      request: parkedEventReplyWithFreeText,
      zhExpected: '允许对「Sure, see you at 10am tomorrow」执行这项操作？',
      enExpected: 'Allow this operation on “Sure, see you at 10am tomorrow”?',
    },
  ])('$name produces specific one-liner in permissionSummary and describeApproval (zh & en)', ({ request, zhExpected, enExpected }) => {
    expect(permissionSummary(request, zh, 'zh')).toBe(zhExpected);
    expect(permissionSummary(request, en, 'en')).toBe(enExpected);
    expect(describeApproval(request, zh, 'zh').question).toBe(zhExpected);
    expect(describeApproval(request, en, 'en').question).toBe(enExpected);

    for (const text of [zhExpected, enExpected]) {
      expect(text).not.toContain(request.tool);
      expect(text).not.toBe(zh.decisionCard.permission.questionFallback);
      expect(text).not.toBe(en.decisionCard.permission.questionFallback);
      expect(text).not.toBe(zh.decisionCard.permission.genericApprovalQuestion);
      expect(text).not.toBe(en.decisionCard.permission.genericApprovalQuestion);
    }
  });

  it('redacts credentials in object preview', () => {
    const req: PermissionRequest = {
      ...mailDraftWithSubject,
      rawArgs: { subject: 'Sync sk-1234567890abcdef1234567890abcdef' },
    };
    const zhText = permissionSummary(req, zh, 'zh');
    const enText = permissionSummary(req, en, 'en');
    expect(zhText).not.toContain('sk-1234567890abcdef1234567890abcdef');
    expect(enText).not.toContain('sk-1234567890abcdef1234567890abcdef');
    expect(zhText).toContain('保存邮件草稿');
    expect(enText).toContain('Save an email draft');
  });

  it('falls back to questionFallback / genericApprovalQuestion only when neither action nor object is known', () => {
    expect(permissionSummary(unknownNetworkFallback, zh, 'zh')).toBe(zh.decisionCard.permission.questionFallback);
    expect(permissionSummary(unknownNetworkFallback, en, 'en')).toBe(en.decisionCard.permission.questionFallback);
    expect(describeApproval(unknownGenericFallback, zh, 'zh').question).toBe(zh.decisionCard.permission.genericApprovalQuestion);
    expect(describeApproval(unknownGenericFallback, en, 'en').question).toBe(en.decisionCard.permission.genericApprovalQuestion);
  });

  it('renders 3-item queue head (mail_draft) with action+object and remainingCount in zh and en', () => {
    i18nState.language = 'zh';
    const { rerender } = render(
      <PermissionCard
        requestOverride={mailDraftContractRequest}
        sessionIdOverride="session-current"
        remainingCount={2}
      />,
    );
    const cardZh = screen.getByTestId('permission-card');
    expect(cardZh.textContent).toContain('保存邮件草稿「本周进度同步」？');
    expect(cardZh.textContent).toContain('还有 2 项');
    expect(cardZh.textContent).not.toContain('允许这次操作？');
    expect(cardZh.textContent).not.toContain('允许进行以下操作？');
    expect(cardZh.textContent).not.toContain('mail_draft');

    i18nState.language = 'en';
    rerender(
      <PermissionCard
        requestOverride={mailDraftContractRequest}
        sessionIdOverride="session-current"
        remainingCount={2}
      />,
    );
    const cardEn = screen.getByTestId('permission-card');
    expect(cardEn.textContent).toContain('Save an email draft “本周进度同步”?');
    expect(cardEn.textContent).toContain('2 more');
    expect(cardEn.textContent).not.toContain('Allow this operation?');
    expect(cardEn.textContent).not.toContain('Allow the following operation?');
    expect(cardEn.textContent).not.toContain('mail_draft');
  });
});
