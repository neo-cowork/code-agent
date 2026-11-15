// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const state = vi.hoisted(() => ({
  request: null as PermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const [{ zh: zhMessages }, { en: enMessages }] = await Promise.all([
    import('../../../src/renderer/i18n/zh'),
    import('../../../src/renderer/i18n/en'),
  ]);
  return {
    useI18n: () => ({
      t: state.language === 'en' ? enMessages : zhMessages,
      language: state.language,
    }),
  };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
    dismissPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
    developerMode: false,
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: null }) => unknown) =>
    selector({ currentSessionId: null }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';

function connectorRequest(): PermissionRequest {
  return {
    id: 'permission-user-quote',
    tool: 'mcp__lark__calendar_v4_calendarEvent_create',
    type: 'mcp',
    sessionId: 's1',
    details: {
      connectorAccess: { connectorId: 'lark', connectorName: 'Feishu', access: 'write' },
      userRequest: { text: 'add Weekly sync tomorrow', truncated: true },
    } as PermissionRequest['details'],
    timestamp: 1,
  };
}

describe('PermissionCard user request quote (whole card, normalizeRequest whitelist)', () => {
  afterEach(() => {
    cleanup();
    state.request = null;
    state.language = 'zh';
  });

  it.each([['zh', zh], ['en', en]] as const)('%s shows the host quote with ellipsis', (language, messages) => {
    state.language = language;
    state.request = connectorRequest();
    render(<PermissionCard />);
    expect(screen.getByTestId('user-request-quote').textContent)
      .toBe(messages.decisionCard.permission.userRequestQuote.replace('{text}', 'add Weekly sync tomorrow…'));
  });

  it.each([
    ['zh', zh, '每日简报'],
    ['en', en, 'Daily brief'],
  ] as const)('%s scheduled-task connector card shows scheduled-task-origin and hides duplicate connector-purpose', (language, messages, taskName) => {
    state.language = language;
    state.request = {
      ...connectorRequest(),
      details: {
        connectorAccess: { connectorId: 'lark', connectorName: language === 'en' ? 'Feishu' : '飞书', access: 'write' },
        purpose: taskName,
        startedByAutomation: true,
      } as PermissionRequest['details'],
    };
    render(<PermissionCard />);
    expect(screen.getByTestId('scheduled-task-origin').textContent)
      .toBe(messages.decisionCard.permission.startedByScheduledTask.replace('{name}', taskName));
    expect(screen.queryByTestId('connector-purpose')).toBeNull();
  });

  it.each([['zh', zh], ['en', en]] as const)('%s non-scheduled connector card with purpose keeps connector-purpose', (language, messages) => {
    state.language = language;
    state.request = {
      ...connectorRequest(),
      details: {
        connectorAccess: { connectorId: 'lark', connectorName: language === 'en' ? 'Feishu' : '飞书', access: 'write' },
        purpose: '每周日程汇总',
        userRequest: { text: '同步下周会议到日历', truncated: false },
      } as PermissionRequest['details'],
    };
    render(<PermissionCard />);
    expect(screen.getByTestId('connector-purpose').textContent)
      .toBe(messages.decisionCard.permission.connectorPurpose.replace('{purpose}', '每周日程汇总'));
    expect(screen.getByTestId('user-request-quote').textContent)
      .toBe(messages.decisionCard.permission.userRequestQuote.replace('{text}', '同步下周会议到日历'));
    expect(screen.queryByTestId('scheduled-task-origin')).toBeNull();
  });

  it.each([['zh', zh], ['en', en]] as const)('%s keeps connector-purpose when startedByAutomation and purpose coexist with a human userRequest quote', (language, messages) => {
    state.language = language;
    state.request = {
      ...connectorRequest(),
      details: {
        connectorAccess: { connectorId: 'lark', connectorName: language === 'en' ? 'Feishu' : '飞书', access: 'write' },
        purpose: '每日简报',
        startedByAutomation: true,
        userRequest: { text: '把简报发到项目群', truncated: false },
      } as PermissionRequest['details'],
    };
    render(<PermissionCard />);
    expect(screen.getByTestId('connector-purpose').textContent)
      .toBe(messages.decisionCard.permission.connectorPurpose.replace('{purpose}', '每日简报'));
    expect(screen.getByTestId('user-request-quote').textContent)
      .toBe(messages.decisionCard.permission.userRequestQuote.replace('{text}', '把简报发到项目群'));
    expect(screen.queryByTestId('scheduled-task-origin')).toBeNull();
  });
});
