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
});
