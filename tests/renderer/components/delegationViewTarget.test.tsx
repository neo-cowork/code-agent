// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSessionListLoadStore } from '../../../src/renderer/stores/sessionListPagination';
import type { ToolCall } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en', invoke: vi.fn() }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: mocks.language === 'zh' ? zh : en }) }));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({ useAgentTreeSnapshot: () => ({ snapshot: null }) }));

const wire = (id: string, title: string) => ({
  id, title, modelConfig: { provider: 'openai', model: 'gpt-5' }, createdAt: 1, updatedAt: 1, messageCount: 1, turnCount: 1,
});

function receipt(targetSessionId?: string): ToolCall {
  const payload = { delegationId: 'd1', target: '购物清单', status: 'active', queuedAhead: 0 };
  return {
    id: 'call', name: 'delegate_session', arguments: { action: 'delegate_existing' },
    result: { toolCallId: 'call', success: true, output: JSON.stringify(payload), metadata: targetSessionId ? { ...payload, targetSessionId } : payload },
  };
}

describe('delegation receipt "view target chat" entry', () => {
  beforeEach(() => {
    mocks.invoke.mockImplementation(async (_d: string, action: string, payload?: { sessionId?: string }) => (
      action === 'load' ? { success: true, data: { ...wire(payload?.sessionId ?? 'x', 't'), messages: [], todos: [] } } : { success: true, data: [] }
    ));
    Object.assign(window, { domainAPI: { invoke: mocks.invoke } });
    useSessionStore.setState({ sessions: [wire('origin', 'Home'), wire('target', '购物清单')] as never, currentSessionId: 'origin', hasOlderSessions: false });
    useSessionListLoadStore.setState({ settled: true, loading: false, error: false });
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  for (const locale of ['zh', 'en'] as const) {
    it(`stays on the originating chat until the button is clicked (${locale})`, async () => {
      mocks.language = locale;
      const view = render(<ToolCallDisplay toolCall={receipt('target')} index={0} total={1} />);
      const button = view.getByTestId('delegation-view-target');
      expect(button.textContent).toBe(locale === 'zh' ? '查看目标会话' : 'View target chat');
      expect(useSessionStore.getState().currentSessionId).toBe('origin');
      fireEvent.click(button);
      await waitFor(() => expect(useSessionStore.getState().currentSessionId).toBe('target'));
    });
  }

  it('offers no entry when the receipt carries no target id', () => {
    const view = render(<ToolCallDisplay toolCall={receipt()} index={0} total={1} />);
    expect(view.queryByTestId('delegation-view-target')).toBeNull();
  });

  it('drops the entry once the target chat is gone from a fully loaded list', () => {
    useSessionStore.setState({ sessions: [wire('origin', 'Home')] as never });
    const view = render(<ToolCallDisplay toolCall={receipt('target')} index={0} total={1} />);
    expect(view.queryByTestId('delegation-view-target')).toBeNull();
  });
});
