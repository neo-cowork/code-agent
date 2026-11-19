// @vitest-environment jsdom
// 无目录空间页 composer 发消息 → 经真实 sessionStore.createSession → create IPC 载荷带 projectId，
// 新会话的 projectId 等于空间 id；侧栏分组补出「还没有会话」的空间。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Project } from '../../../../src/shared/contract/project';
import { IPC_DOMAINS } from '../../../../src/shared/ipc';

vi.mock('../../../../src/renderer/hooks/useToast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/renderer/components/features/chat/ChatInput', () => ({
  ChatInput: (props: { onSend: (e: { content: string }) => unknown }) => {
    const [text, setText] = React.useState('');
    return (
      <div>
        <textarea data-testid="in" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" data-testid="send" onClick={() => { void props.onSend({ content: text }); }}>send</button>
      </div>
    );
  },
}));

import { ProjectComposer } from '../../../../src/renderer/components/features/projectSpace/ProjectComposer';
import { useSessionStore } from '../../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../../src/renderer/stores/appStore';
import { groupByWorkspace } from '../../../../src/renderer/utils/workspaceGrouping';

const SPACE_ID = 'proj_space_nameonly';
const space = {
  id: SPACE_ID, name: '周计划空间', workspacePath: null, workspaceKey: 'k', status: 'active',
  spacePromotedAt: 1, createdAt: 1, updatedAt: 1,
} as unknown as Project;

const createPayloads: Array<Record<string, unknown>> = [];

beforeEach(() => {
  createPayloads.length = 0;
  (window as unknown as { domainAPI: unknown }).domainAPI = {
    invoke: vi.fn(async (domain: string, action: string, payload: Record<string, unknown>) => {
      if (domain === IPC_DOMAINS.SESSION && action === 'create') {
        createPayloads.push(payload);
        // 与 host 契约一致：显式 projectId 优先，否则回落未分类
        return { success: true, data: { id: 'sess-1', title: payload.title, projectId: payload.projectId ?? 'proj_unsorted', createdAt: 1, updatedAt: 1 } };
      }
      if (domain === IPC_DOMAINS.SESSION && action === 'getMessages') return { success: true, data: [] };
      return { success: true, data: null };
    }),
  };
  useAppStore.setState({ language: 'zh' } as never);
  useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [], todos: [], switchSession: vi.fn() } as never);
});
afterEach(() => cleanup());

describe('folderless space composer', () => {
  it('create payload carries the space id and the session belongs to the space', async () => {
    render(<ProjectComposer project={space} />);
    fireEvent.change(screen.getByTestId('in'), { target: { value: '写一篇 600 字的周计划短文' } });
    fireEvent.click(screen.getByTestId('send'));

    await waitFor(() => expect(createPayloads).toHaveLength(1));
    expect(createPayloads[0]).toMatchObject({ projectId: SPACE_ID, workingDirectory: null });
    const created = useSessionStore.getState().sessions[0];
    expect(created.projectId).toBe(SPACE_ID);
  });

  it('a blank draft of another project is never reused for a space create', async () => {
    useSessionStore.setState({
      sessions: [{ id: 'quick-draft', title: '新对话', messageCount: 0, turnCount: 0, projectId: 'proj_unsorted', workingDirectory: undefined, createdAt: 1, updatedAt: 1 }],
      currentSessionId: null,
    } as never);
    render(<ProjectComposer project={space} />);
    fireEvent.change(screen.getByTestId('in'), { target: { value: '你好' } });
    fireEvent.click(screen.getByTestId('send'));
    await waitFor(() => expect(createPayloads).toHaveLength(1));
    expect(createPayloads[0].projectId).toBe(SPACE_ID);
  });
});

describe('plain new chat vs a blank folderless space draft', () => {
  it('does not reuse the space draft; the created session is not in that space', async () => {
    useSessionStore.setState({
      sessions: [{ id: 'space-draft', title: '新对话', messageCount: 0, turnCount: 0, projectId: SPACE_ID, workingDirectory: undefined, createdAt: 1, updatedAt: 1 }],
      currentSessionId: null,
    } as never);
    await useSessionStore.getState().createSession('新对话', { workingDirectory: null });
    expect(createPayloads).toHaveLength(1);
    expect(createPayloads[0].projectId).toBeUndefined();
    const created = useSessionStore.getState().sessions.find((x) => x.id === 'sess-1');
    expect(created?.projectId).toBe('proj_unsorted');
  });
});

describe('groupByWorkspace empty spaces', () => {
  it('adds a project:<id> group with no sessions for a space that has none yet', () => {
    const groups = groupByWorkspace([], '快速对话', '项目', [{ id: SPACE_ID, name: '周计划空间', workspacePath: null }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: `project:${SPACE_ID}`, name: '周计划空间', projectId: SPACE_ID, sessions: [], paths: [] });
  });
});
