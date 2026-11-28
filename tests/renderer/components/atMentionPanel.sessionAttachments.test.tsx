// @vitest-environment jsdom
// ============================================================================
// FB-3095：@ 面板文件组并入本会话附件（上传落在 <data>/uploads/<uuid>/，不在工作目录里）
// ============================================================================
// 场景：本会话上传过 top_level.txt，切会话再切回，@ -> Files 里搜 top_level 原来 0 结果。
// 验收口径：附件行进文件组（query 无 '/' 时）、同一 fileNameFilter、新上传在前、同名去重
// （工作区文件赢 / 重复上传取最新）、无工作目录也成立、内部 uploads 路径绝不进 UI。

import React from 'react';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessageAttachment } from '../../../src/shared/contract/message';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { AtMentionPopover } from '../../../src/renderer/components/features/chat/ChatInput/AtMentionPopover';
import type { AtMentionFileRow } from '../../../src/renderer/components/features/chat/ChatInput/atMentionPanelModel';

const mocks = vi.hoisted(() => ({
  listLibraryItems: vi.fn(),
  getSessionPin: vi.fn(),
  setSessionPin: vi.fn(),
  listProjects: vi.fn(),
  getProjectArtifacts: vi.fn(),
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: mocks.listLibraryItems,
  getSessionPin: mocks.getSessionPin,
  setSessionPin: mocks.setSessionPin,
}));
vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjects: mocks.listProjects,
  getProjectArtifacts: mocks.getProjectArtifacts,
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: mocks.toast }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => (mocks.language === 'en'
      ? { t: en, language: 'en' as const }
      : { t: zh, language: 'zh' as const }),
  };
});

import { useAtMentionPanel } from '../../../src/renderer/components/features/chat/ChatInput/useAtMentionPanel';

const UPLOAD_ROOT = '/Users/tester/.code-agent/uploads';
const WORKSPACE_FILES = [
  { name: 'alpha.ts', path: '/tmp/at-mention-proj/alpha.ts', isDirectory: false },
  { name: 'docs', path: '/tmp/at-mention-proj/docs', isDirectory: true },
];

function upload(name: string, uuid: string, overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: `att-${uuid}-${name}`,
    type: 'file',
    category: 'text',
    name,
    size: 41,
    mimeType: 'text/plain',
    path: `${UPLOAD_ROOT}/${uuid}/${name}`,
    data: 'file contents',
    ...overrides,
  };
}

function userMessage(id: string, attachments: MessageAttachment[], timestamp = 1): Message {
  return { id, role: 'user', content: 'please read this file', timestamp, attachments };
}

describe('useAtMentionPanel 会话附件并入文件组', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    useAppStore.setState({ workingDirectory: '/tmp/at-mention-proj' });
    mocks.listLibraryItems.mockResolvedValue([]);
    mocks.getSessionPin.mockResolvedValue({ sessionId: 'session-1', itemIds: [] });
    mocks.setSessionPin.mockResolvedValue({ sessionId: 'session-1', itemIds: [] });
    mocks.listProjects.mockResolvedValue([]);
    mocks.getProjectArtifacts.mockResolvedValue([]);
    (window as { domainAPI?: unknown }).domainAPI = {
      invoke: vi.fn().mockImplementation((_domain: string, action: string) => Promise.resolve({
        success: true,
        data: action === 'list' ? [] : WORKSPACE_FILES,
      })),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    mocks.language = 'zh';
    useAppStore.setState({ workingDirectory: null });
    useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [] });
  });

  function seedSession(messages: Message[], sessionId = 'session-1') {
    useSessionStore.setState({ currentSessionId: sessionId, messages });
  }

  function setup(sessionId: string | null = 'session-1') {
    return renderHook(() => useAtMentionPanel({
      sessionId,
      projectId: 'proj-1',
      onFileSelect: vi.fn(),
      onSessionSelect: vi.fn(),
      onArtifactSelect: vi.fn(),
      onLibrarySelect: vi.fn(),
    }));
  }

  async function search(result: { current: ReturnType<typeof useAtMentionPanel> }, text: string) {
    await act(async () => {
      result.current.search(text, text.length);
      await vi.advanceTimersByTimeAsync(250);
    });
  }

  function renderPopover(result: { current: ReturnType<typeof useAtMentionPanel> }) {
    return render(
      <AtMentionPopover
        query={result.current.query}
        libraryRows={result.current.libraryRows}
        fileRows={result.current.fileRows}
        sessionRows={result.current.sessionRows}
        artifactRows={result.current.artifactRows}
        activeTab={result.current.activeTab}
        selectedIndex={result.current.selectedIndex}
        onTabChange={result.current.setActiveTab}
        onSelect={result.current.selectRow}
        onHover={result.current.setSelectedIndex}
      />,
    );
  }

  it('(a) 会话附件在工作区没有同名文件时按文件名搜到，行带本会话附件提示且不落 uploads 路径', async () => {
    seedSession([userMessage('m1', [upload('top_level.txt', 'uuid-1')])]);
    const { result } = setup();
    await search(result, '@top_level');

    const rows = result.current.fileRows;
    expect(rows.map((row) => row.name)).toEqual(['top_level.txt']);
    expect(rows[0]).toMatchObject({ source: 'attachment', dir: '', isDirectory: false });

    const view = renderPopover(result);
    const text = view.container.textContent ?? '';
    expect(text).toContain('top_level.txt');
    expect(text).toContain('本会话附件');
    expect(text).not.toContain('uploads/');
    expect(text).not.toContain('uuid-1');
    // 行的 title/aria 也不能带内部路径
    expect(view.container.innerHTML).not.toContain('uploads/');
    cleanup();

    mocks.language = 'en';
    const viewEn = renderPopover(result);
    expect(viewEn.container.textContent ?? '').toContain('Attached in this chat');
    expect(viewEn.container.textContent ?? '').not.toContain('uploads/');
  });

  it('(b) 工作区有同名文件时只留一行，且工作区文件赢', async () => {
    (window as { domainAPI?: { invoke: unknown } }).domainAPI = {
      invoke: vi.fn().mockImplementation((_domain: string, action: string) => Promise.resolve({
        success: true,
        data: action === 'list' ? [] : [
          ...WORKSPACE_FILES,
          { name: 'top_level.txt', path: '/tmp/at-mention-proj/top_level.txt', isDirectory: false },
        ],
      })),
    };
    seedSession([userMessage('m1', [upload('top_level.txt', 'uuid-1')])]);
    const { result } = setup();
    await search(result, '@top_level');

    const named = result.current.fileRows.filter((row) => row.name === 'top_level.txt');
    expect(named).toHaveLength(1);
    expect(named[0].source).not.toBe('attachment');
    expect(named[0].path).toBe('/tmp/at-mention-proj/top_level.txt');
  });

  it('(c) 没有工作目录时附件行仍出现', async () => {
    useAppStore.setState({ workingDirectory: null });
    seedSession([userMessage('m1', [upload('top_level.txt', 'uuid-1')])]);
    const { result } = setup();
    await search(result, '@top_level');

    expect(result.current.fileRows.map((row) => row.name)).toEqual(['top_level.txt']);
    expect(result.current.fileRows[0].source).toBe('attachment');
  });

  it('(d) 切走 currentSessionId 再切回，附件行跟着回来', async () => {
    seedSession([userMessage('m1', [upload('top_level.txt', 'uuid-1')])]);
    const { result } = setup();
    await search(result, '@top_level');
    expect(result.current.fileRows.map((row) => row.name)).toEqual(['top_level.txt']);

    act(() => {
      useSessionStore.setState({ currentSessionId: 'other-session', messages: [] });
    });
    expect(result.current.fileRows.map((row) => row.name)).toEqual([]);

    act(() => {
      useSessionStore.setState({
        currentSessionId: 'session-1',
        messages: [userMessage('m1', [upload('top_level.txt', 'uuid-1')])],
      });
    });
    expect(result.current.fileRows.map((row) => row.name)).toEqual(['top_level.txt']);
  });

  it('(e) 会话没有附件时文件组与现状一致', async () => {
    seedSession([userMessage('m1', [])]);
    const { result } = setup();
    await search(result, '@');

    expect(result.current.fileRows.map((row) => row.name)).toEqual(['alpha.ts', 'docs']);
    expect(result.current.fileRows.every((row) => row.source === undefined)).toBe(true);
  });

  it('同名附件重复上传取最新一条，且新上传排在工作区行之前', async () => {
    seedSession([
      userMessage('m1', [upload('top_level.txt', 'uuid-old')], 1),
      userMessage('m2', [upload('top_level.txt', 'uuid-new')], 2),
    ]);
    const { result } = setup();
    await search(result, '@');

    const rows = result.current.fileRows;
    expect(rows[0]).toMatchObject({ name: 'top_level.txt', source: 'attachment', path: `${UPLOAD_ROOT}/uuid-new/top_level.txt` });
    expect(rows.filter((row) => row.name === 'top_level.txt')).toHaveLength(1);
  });

  it('浏览子目录（query 含 /）时不掺附件', async () => {
    seedSession([userMessage('m1', [upload('top_level.txt', 'uuid-1')])]);
    const { result } = setup();
    await search(result, '@docs/top');

    expect(result.current.fileRows.every((row) => row.source !== 'attachment')).toBe(true);
  });

  it('folder 类附件与相对 path 附件不进候选', async () => {
    const folderAttachment: MessageAttachment = {
      id: 'att-folder', type: 'file', category: 'folder', name: 'mydir', size: 0,
      mimeType: '', path: `${UPLOAD_ROOT}/uuid-1/mydir`,
    };
    const relativeAttachment: MessageAttachment = {
      id: 'att-rel', type: 'file', category: 'text', name: 'rel.txt', size: 1,
      mimeType: 'text/plain', path: 'rel.txt',
    };
    seedSession([userMessage('m1', [folderAttachment, relativeAttachment])]);
    const { result } = setup();
    await search(result, '@');

    expect(result.current.fileRows.every((row) => row.source !== 'attachment')).toBe(true);
  });

  it('选中附件行走 handleAtFileSelect 同一入口（绝对 path 交给组件构建附件）', async () => {
    const onFileSelect = vi.fn();
    seedSession([userMessage('m1', [upload('top_level.txt', 'uuid-1')])]);
    const { result } = renderHook(() => useAtMentionPanel({
      sessionId: 'session-1',
      projectId: 'proj-1',
      onFileSelect,
      onSessionSelect: vi.fn(),
      onArtifactSelect: vi.fn(),
      onLibrarySelect: vi.fn(),
    }));
    await search(result, '@top_level');

    const row = result.current.fileRows[0] as AtMentionFileRow;
    act(() => { result.current.selectRow(row); });
    expect(onFileSelect).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'file',
      name: 'top_level.txt',
      path: `${UPLOAD_ROOT}/uuid-1/top_level.txt`,
      isDirectory: false,
    }));
  });
});
