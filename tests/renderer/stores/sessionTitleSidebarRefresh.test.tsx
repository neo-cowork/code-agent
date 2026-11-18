// @vitest-environment jsdom
// 标题只带 title 的 session:updated 必须换掉侧栏行上的 30 字临时标题，其它字段不动。
// 走 initializeSessionStore 注册的真实 listener 和 normalize，只替传输层。
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { Session } from '../../../src/shared/contract';
import { useSidebarDerivedSessions } from '../../../src/renderer/components/features/sidebar/useSidebarDerivedSessions';
import { getLocalizedSessionTitle } from '../../../src/renderer/utils/sessionPresentation';
import { initializeSessionStore, useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const PROMPT = '帮我看看 workspace 里的服务合同.pdf，先查一下有没有可用的 PDF 工具，再总结要点';
const SESSION_ID = 'web-session-title-sidebar';
const OTHER_ID = 'web-session-other';
const NEXT_TITLE = '看看 workspace';

function provisionalTitle(prompt: string): string {
  return prompt.length > 30 ? `${prompt.slice(0, 30)}...` : prompt;
}

function installTransport(): (channel: string, event: unknown) => void {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const api = {
    invoke: vi.fn(async () => []),
    on: (channel: string, callback: (event: unknown) => void) => {
      const bucket = listeners.get(channel) ?? new Set<(event: unknown) => void>();
      bucket.add(callback);
      listeners.set(channel, bucket);
      return () => {
        bucket.delete(callback);
      };
    },
    off: () => undefined,
  };
  Object.assign(window, {
    codeAgentAPI: api,
    electronAPI: api,
    domainAPI: {
      invoke: vi.fn(async () => ({ success: true, data: [] })),
    },
  });
  return (channel, event) => {
    for (const listener of [...(listeners.get(channel) ?? [])]) listener(event);
  };
}

function seedRow(id: string, title: string, status: Session['status']): SessionWithMeta {
  return {
    id,
    title,
    status,
    modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
    workingDirectory: '/workspace',
    createdAt: 111,
    updatedAt: 222,
    messageCount: 3,
    turnCount: 1,
    gitBranch: 'main',
  };
}

function sidebarRow(sessions: SessionWithMeta[], id: string): SessionWithMeta | undefined {
  return sessions.find((session) => session.id === id);
}

describe('标题 session:updated 换掉侧栏临时标题', () => {
  afterEach(() => {
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      messages: [],
    });
  });

  it('只带 title 的更新替换临时标题，status 仍是 running', async () => {
    const emit = installTransport();
    const placeholder = provisionalTitle(PROMPT);
    useSessionStore.setState({ currentSessionId: SESSION_ID, sessions: [] });
    await initializeSessionStore();
    useSessionStore.setState({
      currentSessionId: SESSION_ID,
      sessions: [
        seedRow(SESSION_ID, placeholder, 'running'),
        seedRow(OTHER_ID, '别的对话', 'idle'),
      ],
    });

    const { result, unmount } = renderHook(() => useSidebarDerivedSessions({ canOpenSessionReplay: false }));
    try {
      const listed = () => result.current.workspaceGroupedSessions.flatMap((group) => group.sessions);
      const before = sidebarRow(listed(), SESSION_ID);
      expect(before?.title).toBe(placeholder);
      expect(placeholder.endsWith('...')).toBe(true);
      expect(placeholder.length).toBe(33);

      act(() => {
        emit(IPC_CHANNELS.SESSION_UPDATED, {
          sessionId: SESSION_ID,
          updates: { title: NEXT_TITLE },
        });
      });

      const stored = useSessionStore.getState().sessions.find((session) => session.id === SESSION_ID);
      const shown = sidebarRow(listed(), SESSION_ID);
      const other = sidebarRow(listed(), OTHER_ID);

      expect(stored?.title).toBe(NEXT_TITLE);
      expect(stored?.status).toBe('running');
      expect(stored?.modelConfig).toEqual({ provider: 'xiaomi', model: 'mimo-v2.6-flash' });
      expect(stored?.workingDirectory).toBe('/workspace');
      expect(stored?.createdAt).toBe(111);
      expect(stored?.updatedAt).toBe(222);
      expect(stored?.messageCount).toBe(3);
      expect(stored?.turnCount).toBe(1);
      expect(stored?.gitBranch).toBe('main');
      expect(shown?.title).toBe(NEXT_TITLE);
      expect(shown?.status).toBe('running');
      expect(getLocalizedSessionTitle(shown?.title, 'zh')).toBe(NEXT_TITLE);
      expect(other?.title).toBe('别的对话');
      expect(other?.status).toBe('idle');
    } finally {
      unmount();
    }
  });
});
