// @vitest-environment jsdom
// ============================================================================
// @ 触发面板（任务 14/15）：分组模型 + 资料库 pin + 键盘导航
// ============================================================================

import React from 'react';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryItem } from '../../../src/shared/contract/library';
import type { ProjectArtifact } from '../../../src/shared/contract/project';
import type { Session } from '../../../src/shared/contract/session';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { AtMentionPopover } from '../../../src/renderer/components/features/chat/ChatInput/AtMentionPopover';
import {
  buildArtifactRows,
  buildFileRows,
  buildLibraryRows,
  buildSessionRows,
  deriveFileDir,
  flattenAtMentionRows,
  groupLimitForTab,
  shiftAtMentionTab,
  wrapIndex,
  type AtMentionLibraryRow,
} from '../../../src/renderer/components/features/chat/ChatInput/atMentionPanelModel';

const mocks = vi.hoisted(() => ({
  listLibraryItems: vi.fn(),
  getSessionPin: vi.fn(),
  setSessionPin: vi.fn(),
  listProjects: vi.fn(),
  getProjectArtifacts: vi.fn(),
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
  // 渲染用语言（默认 zh 保持既有用例行为；渲染用例内切换 en 后须复位）
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

function libraryItem(id: string, projectId: string | null, title = id): LibraryItem {
  return {
    id,
    projectId,
    title,
    kind: 'upload',
    pathOrUri: `/lib/${id}.md`,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function session(id: string, title: string, projectId = 'proj-1'): Session & { messageCount: number } {
  return {
    id,
    title,
    projectId,
    modelConfig: {} as Session['modelConfig'],
    createdAt: 1,
    updatedAt: 2,
    messageCount: 6,
  };
}

function keyEvent(key: string): React.KeyboardEvent<HTMLTextAreaElement> {
  return {
    key,
    preventDefault: vi.fn(),
    nativeEvent: { isComposing: false, keyCode: key === 'Enter' ? 13 : 0 },
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
}

describe('atMentionPanelModel', () => {
  it('资料库组只保留 本项目 ∪ 全局 候选，并按 query 过滤', () => {
    const items = [
      libraryItem('p1', 'proj-1', '发布 checklist'),
      libraryItem('p2', 'proj-2', '别的项目资料'),
      libraryItem('g1', null, '全局品牌套件'),
    ];
    const rows = buildLibraryRows(items, 'proj-1', new Set(), '');
    expect(rows.map((row) => row.item.id)).toEqual(['p1', 'g1']);

    const filtered = buildLibraryRows(items, 'proj-1', new Set(), '品牌');
    expect(filtered.map((row) => row.item.id)).toEqual(['g1']);
  });

  it('已 pin 的条目行带 pinned 选中态，且每组封顶 8 条', () => {
    const items = Array.from({ length: 10 }, (_, i) => libraryItem(`g${i}`, null));
    const rows = buildLibraryRows(items, null, new Set(['g3']), '');
    expect(rows).toHaveLength(8);
    expect(rows.find((row) => row.item.id === 'g3')?.pinned).toBe(true);
    expect(rows.find((row) => row.item.id === 'g0')?.pinned).toBe(false);
  });

  it('文件组沿用名称子串过滤并推导所在目录', () => {
    const rows = buildFileRows([
      { path: 'src/foo/bar.ts', name: 'bar.ts', isDirectory: false },
      { path: 'README.md', name: 'README.md', isDirectory: false },
      { path: 'src/foo', name: 'foo', isDirectory: true },
    ], 'bar');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'bar.ts', dir: 'src/foo', isDirectory: false });
    expect(deriveFileDir('README.md', 'README.md')).toBe('');
  });

  it('键盘导航在平铺序列上跨组循环', () => {
    const libraryRows = buildLibraryRows([libraryItem('g1', null)], null, new Set(), '');
    const fileRows = buildFileRows([
      { path: 'a.ts', name: 'a.ts', isDirectory: false },
      { path: 'b.ts', name: 'b.ts', isDirectory: false },
    ], '');
    const flat = flattenAtMentionRows(libraryRows, fileRows);
    expect(flat.map((row) => row.kind)).toEqual(['library', 'file', 'file']);
    expect(wrapIndex(2, 1, flat.length)).toBe(0);
    expect(wrapIndex(0, -1, flat.length)).toBe(2);
  });

  it('会话与产物按标题/来源过滤，全部档每组 2 条、单类档 8 条', () => {
    const sessions = Array.from({ length: 10 }, (_, index) => session(`s${index}`, `设计会话 ${index}`));
    const sessionRows = buildSessionRows(sessions, new Map([['proj-1', 'Neo 项目']]), '设计', null, groupLimitForTab('all'));
    expect(sessionRows).toHaveLength(2);
    expect(sessionRows[0]).toMatchObject({ title: '设计会话 0', projectName: 'Neo 项目', messageCount: 6 });

    const artifacts = Array.from({ length: 10 }, (_, index) => ({
      id: `a${index}`,
      sessionId: 's0',
      sessionTitle: '设计会话 0',
      kind: index === 0 ? 'generic_html' : 'file',
      title: `方案-${index}.html`,
      createdAt: 3,
    })) as ProjectArtifact[];
    const artifactRows = buildArtifactRows(artifacts, '方案', groupLimitForTab('artifacts'));
    expect(artifactRows).toHaveLength(8);
    expect(artifactRows[0]).toMatchObject({ artifactType: 'html', sessionTitle: '设计会话 0' });
  });

  it('Tab 循环切换有五档，分组平铺包含会话与产物', () => {
    expect(shiftAtMentionTab('all', -1)).toBe('artifacts');
    expect(shiftAtMentionTab('artifacts', 1)).toBe('all');
    expect(flattenAtMentionRows([], [], [buildSessionRows([session('s1', '会话')], new Map(), '', null)[0]], [
      buildArtifactRows([{ id: 'a1', sessionId: 's1', kind: 'file', title: '报告.docx', createdAt: 1 }], '')[0],
    ]).map((row) => row.kind)).toEqual(['session', 'artifact']);
  });

  it('空 query 跳过点开头条目（首屏不被 .claude/.code-agent 占据），非空 query 照旧可搜到', () => {
    const files = [
      { name: '.claude', path: '/w/.claude', isDirectory: true },
      { name: '.code-agent', path: '/w/.code-agent', isDirectory: true },
      { name: 'src', path: '/w/src', isDirectory: true },
      { name: 'README.md', path: '/w/README.md', isDirectory: false },
    ];
    expect(buildFileRows(files, '').map((row) => row.name)).toEqual(['src', 'README.md']);
    // `.` 非空：子串过滤照旧（README.md 也含 `.`），点开头条目仍可搜到
    expect(buildFileRows(files, '.').map((row) => row.name)).toEqual(['.claude', '.code-agent', 'README.md']);
    expect(buildFileRows(files, 'claude').map((row) => row.name)).toEqual(['.claude']);
  });
});

// ============================================================================
// N-FIX-ATMENTION-POPOVER-INTERNAL-PATH-EXPOSED：资料库行第二行灰字绝不外露内部存储
// 绝对路径（~/…/library/proj_xxx/…），无 summary 时显示类型人话标签；external_ref
// 的 http(s) URL 附 host。文件组空 query 不列点开头目录。经 AtMentionPopover 公共
// props 渲染断言，不直接调内部 helper。
// ============================================================================
describe('AtMentionPopover 资料库行第二行不外露内部路径', () => {
  beforeEach(() => {
    // jsdom 未实现 scrollIntoView；组件高亮行的滚动跟随在渲染用例里只需不炸
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    mocks.language = 'zh';
  });

  function renderPopover(libraryRows: AtMentionLibraryRow[]): string {
    const { container } = render(
      <AtMentionPopover
        query=""
        libraryRows={libraryRows}
        fileRows={[]}
        sessionRows={[]}
        artifactRows={[]}
        activeTab="all"
        selectedIndex={0}
        onTabChange={vi.fn()}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );
    return container.textContent ?? '';
  }

  it('无 summary 的本地条目显示类型标签，不显示 /Users/…/proj_ 路径（zh）', () => {
    const item = libraryItem('p1', 'proj-1', '品牌色规范');
    item.pathOrUri = '/Users/me/.code-agent-dev/library/proj_7c9d42b5abb9/upload/brand.pdf';
    const text = renderPopover([{ kind: 'library', item, pinned: false }]);
    expect(text).toContain('上传文件');
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('proj_');
  });

  it('无 summary 的本地条目显示类型标签，不显示内部路径（en）', () => {
    mocks.language = 'en';
    const item = libraryItem('p1', 'proj-1', 'Brand colors');
    item.pathOrUri = '/Users/me/.code-agent-dev/library/proj_7c9d42b5abb9/upload/brand.pdf';
    const text = renderPopover([{ kind: 'library', item, pinned: false }]);
    expect(text).toContain('Uploaded file');
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('proj_');
  });

  it('summary 非空时仍以 summary 为第二行', () => {
    const item = libraryItem('p1', 'proj-1', '品牌色规范');
    item.pathOrUri = '/Users/me/.code-agent-dev/library/proj_7c9d42b5abb9/upload/brand.pdf';
    item.summary = '主色 #171717，强调色 zinc';
    const text = renderPopover([{ kind: 'library', item, pinned: false }]);
    expect(text).toContain('主色 #171717，强调色 zinc');
    expect(text).not.toContain('/Users/');
  });

  it('external_ref 的 http(s) URL 显示「类型标签 · host」，不显示完整 URL 路径段', () => {
    const item = libraryItem('p1', 'proj-1', '设计系统文档');
    item.kind = 'external_ref';
    item.pathOrUri = 'https://design.example.com/spec/brand/colors';
    const text = renderPopover([{ kind: 'library', item, pinned: false }]);
    expect(text).toContain('外部引用 · design.example.com');
    expect(text).not.toContain('/spec/brand/colors');
    expect(text).not.toContain('https://');
  });
});

describe('useAtMentionPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // FB-1531 后 @ 面板文件列表以工作目录为基目录；旧夹具靠「无目录也返回数据」撑起文件组
    useAppStore.setState({ workingDirectory: '/tmp/at-mention-proj' });
    mocks.listLibraryItems.mockResolvedValue([
      libraryItem('p1', 'proj-1', '发布 checklist'),
      libraryItem('g1', null, '全局品牌套件'),
    ]);
    mocks.getSessionPin.mockResolvedValue({ sessionId: 'session-1', itemIds: ['g1'] });
    mocks.setSessionPin.mockResolvedValue({ sessionId: 'session-1', itemIds: [] });
    mocks.listProjects.mockResolvedValue([{ id: 'proj-1', name: 'Neo 项目' }]);
    mocks.getProjectArtifacts.mockResolvedValue([
      { id: 'a1', sessionId: 'past-1', sessionTitle: '历史设计', kind: 'generic_html', title: 'demo.html', createdAt: 3 },
    ]);
    (window as { domainAPI?: unknown }).domainAPI = {
      invoke: vi.fn().mockImplementation((_domain: string, action: string) => Promise.resolve({
        success: true,
        data: action === 'list'
          ? [session('past-1', '历史设计')]
          : [
              { name: 'alpha.ts', path: 'src/alpha.ts', isDirectory: false },
              { name: 'docs', path: 'docs', isDirectory: true },
            ],
      })),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    useAppStore.setState({ workingDirectory: null });
    useSessionStore.setState({ sessions: [], currentSessionId: null });
  });

  function setup(onFileSelect = vi.fn(), onSessionSelect = vi.fn(), onArtifactSelect = vi.fn(), onLibrarySelect = vi.fn()) {
    return renderHook(() => useAtMentionPanel({
      sessionId: 'session-1',
      projectId: 'proj-1',
      onFileSelect,
      onSessionSelect,
      onArtifactSelect,
      onLibrarySelect,
    }));
  }

  async function openPanel(result: { current: ReturnType<typeof useAtMentionPanel> }) {
    await act(async () => {
      result.current.search('@', 1);
      await vi.advanceTimersByTimeAsync(250);
    });
  }

  it.each([{}, { metaKey: true }, { ctrlKey: true }])(
    'consumes fast Enter before the @ panel opens (%j), then selects the file on a later Enter',
    async (modifiers) => {
      const onFileSelect = vi.fn();
      const { result } = setup(onFileSelect);
      await act(async () => { result.current.search('@alpha', 6); });
      expect(result.current.isOpen).toBe(false);
      const enter = { ...keyEvent('Enter'), ...modifiers };
      expect(result.current.handleKeyDown(enter)).toBe(true);
      expect(enter.preventDefault).toHaveBeenCalledOnce();
      expect(onFileSelect).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(result.current.isOpen).toBe(true);
      const select = keyEvent('Enter');
      act(() => { expect(result.current.handleKeyDown(select)).toBe(true); });
      expect(select.preventDefault).toHaveBeenCalledOnce();
      expect(onFileSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'alpha.ts' }));
    },
  );

  it('consumes fast Enter in the new debounce window after clearing and retyping', async () => {
    const { result } = setup();
    await act(async () => { result.current.search('@alpha', 6); });
    act(() => { result.current.search('', 0); });
    expect(result.current.handleKeyDown(keyEvent('Enter'))).toBe(false);
    await act(async () => { result.current.search('@docs', 5); });
    const enter = keyEvent('Enter');
    expect(result.current.handleKeyDown(enter)).toBe(true);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
  });

  it('leaves Shift+Enter and IME Enter alone while the @ panel is pending', async () => {
    const { result } = setup();
    await act(async () => { result.current.search('@alpha', 6); });
    const shift = { ...keyEvent('Enter'), shiftKey: true };
    const ime = { ...keyEvent('Enter'), nativeEvent: { ...keyEvent('Enter').nativeEvent, isComposing: true } };
    for (const enter of [shift, ime]) {
      expect(result.current.handleKeyDown(enter)).toBe(false);
      expect(enter.preventDefault).not.toHaveBeenCalled();
    }
  });

  it('consumes Enter while listFiles is unresolved and after a superseded lookup resolves', async () => {
    const files = Promise.withResolvers<{ success: boolean; data: [] }>();
    const invoke = vi.mocked(window.domainAPI!.invoke);
    const originalInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation((...args) => args[1] === 'listFiles'
      ? files.promise as ReturnType<typeof originalInvoke>
      : originalInvoke(...args));
    const { result } = setup();
    await act(async () => {
      result.current.search('@alpha', 6);
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(invoke).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'listFiles', expect.anything());
    expect(result.current.isOpen).toBe(false);
    const enter = keyEvent('Enter');
    expect(result.current.handleKeyDown(enter)).toBe(true);
    expect(enter.preventDefault).toHaveBeenCalledOnce();

    await act(async () => {
      result.current.search('@docs', 5);
      files.resolve({ success: true, data: [] });
    });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.handleKeyDown(keyEvent('Enter'))).toBe(true);
  });

  it('打开后同时给出资料库组与工作区文件组，pin 态来自 getSessionPin', async () => {
    const { result } = setup();
    await openPanel(result);

    expect(result.current.isOpen).toBe(true);
    expect(result.current.libraryRows.map((row) => [row.item.id, row.pinned])).toEqual([['p1', false], ['g1', true]]);
    expect(result.current.fileRows.map((row) => row.name)).toEqual(['alpha.ts', 'docs']);
    expect(result.current.sessionRows.map((row) => row.id)).toEqual(['past-1']);
    expect(result.current.artifactRows.map((row) => row.id)).toEqual(['a1']);
    expect(result.current.flatRows).toHaveLength(6);
  });

  it('↑↓ 跨组循环，Enter 选中资料库行 = 钉上并关闭，选中文件行 = 插入并关闭', async () => {
    const onFileSelect = vi.fn();
    const onLibrarySelect = vi.fn();
    const { result } = setup(onFileSelect, vi.fn(), vi.fn(), onLibrarySelect);
    await openPanel(result);

    // 从 0 向上 = 循环到最后一行（文件 docs）
    act(() => { result.current.handleKeyDown(keyEvent('ArrowUp')); });
    expect(result.current.selectedIndex).toBe(5);
    act(() => { result.current.handleKeyDown(keyEvent('ArrowDown')); });
    expect(result.current.selectedIndex).toBe(0);

    // Enter 在资料库行：幂等钉上，面板关闭（旧断言 isOpen 保持 true 是 FB-2793）
    await act(async () => { result.current.handleKeyDown(keyEvent('Enter')); });
    expect(mocks.setSessionPin).toHaveBeenCalledWith('session-1', ['g1', 'p1']);
    expect(onLibrarySelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'library', item: expect.objectContaining({ id: 'p1' }) }));
    expect(result.current.isOpen).toBe(false);
    expect(result.current.libraryRows[0]?.pinned).toBe(true);

    // 重新打开后移到文件行 Enter：插入路径并关闭面板
    await openPanel(result);
    act(() => { result.current.handleKeyDown(keyEvent('ArrowDown')); });
    act(() => { result.current.handleKeyDown(keyEvent('ArrowDown')); });
    act(() => { result.current.handleKeyDown(keyEvent('Enter')); });
    // 文件行选中把整行交给组件（文件 → 内联 chip + 附件；目录 → @path 文本）
    expect(onFileSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/alpha.ts', name: 'alpha.ts', isDirectory: false }));
    expect(result.current.isOpen).toBe(false);
  });

  it('Enter 选中资料库行后 pin 恰为 1 条，再选同一行仍是 1 条且不取消', async () => {
    const pinned: string[] = [];
    mocks.listLibraryItems.mockResolvedValue([libraryItem('lib-1', 'proj-1', 'dogfood-upload-test')]);
    mocks.getSessionPin.mockImplementation(async () => ({ sessionId: 'session-1', itemIds: [...pinned] }));
    mocks.setSessionPin.mockImplementation(async (sessionId: string, itemIds: string[]) => {
      pinned.splice(0, pinned.length, ...itemIds);
      return { sessionId, itemIds: [...pinned] };
    });
    const onLibrarySelect = vi.fn();
    const { result } = setup(vi.fn(), vi.fn(), vi.fn(), onLibrarySelect);
    await openPanel(result);

    await act(async () => { result.current.handleKeyDown(keyEvent('Enter')); });
    expect(result.current.isOpen).toBe(false);
    expect(pinned).toEqual(['lib-1']);
    expect(mocks.setSessionPin).toHaveBeenCalledTimes(1);
    expect(onLibrarySelect).toHaveBeenCalledTimes(1);

    await openPanel(result);
    expect(result.current.libraryRows.map((row) => [row.item.id, row.pinned])).toEqual([['lib-1', true]]);
    act(() => { result.current.handleKeyDown(keyEvent('Enter')); });
    expect(result.current.isOpen).toBe(false);
    expect(pinned).toEqual(['lib-1']);
    expect(mocks.setSessionPin).toHaveBeenCalledTimes(1);
  });

  it('鼠标点击资料库行与 Enter 同走 selectRow：关掉面板且 pin 恰为 1 条', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    mocks.listLibraryItems.mockResolvedValue([libraryItem('lib-1', 'proj-1', 'dogfood-upload-test')]);
    mocks.getSessionPin.mockResolvedValue({ sessionId: 'session-1', itemIds: [] });
    const { result } = setup();
    await openPanel(result);
    const view = render(
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
    await act(async () => { fireEvent.click(view.getByRole('button', { name: /dogfood-upload-test/ })); });
    expect(result.current.isOpen).toBe(false);
    expect(mocks.setSessionPin).toHaveBeenLastCalledWith('session-1', ['lib-1']);
    cleanup();
  });

  it('草稿无会话时资料库行只追加 pending pin，再选一次不取消', async () => {
    useComposerStore.setState({ pendingPinItemIds: [] });
    const onLibrarySelect = vi.fn();
    const { result } = renderHook(() => useAtMentionPanel({
      sessionId: null,
      projectId: null,
      onFileSelect: vi.fn(),
      onSessionSelect: vi.fn(),
      onArtifactSelect: vi.fn(),
      onLibrarySelect,
    }));
    await openPanel(result);
    expect(result.current.flatRows[0]).toMatchObject({ kind: 'library', item: { id: 'g1' } });

    act(() => { result.current.handleKeyDown(keyEvent('Enter')); });
    expect(result.current.isOpen).toBe(false);
    expect(useComposerStore.getState().pendingPinItemIds).toEqual(['g1']);
    expect(mocks.setSessionPin).not.toHaveBeenCalled();

    await openPanel(result);
    act(() => { result.current.handleKeyDown(keyEvent('Enter')); });
    await act(async () => { await Promise.resolve(); });
    expect(useComposerStore.getState().pendingPinItemIds).toEqual(['g1']);
    expect(result.current.isOpen).toBe(false);
    useComposerStore.setState({ pendingPinItemIds: [] });
  });

  it('Ctrl+←/→ 切 Tab，裸 ←/→ 留给输入框；会话 Enter 交给引用 chip 入口', async () => {
    const onSessionSelect = vi.fn();
    const { result } = setup(vi.fn(), onSessionSelect);
    await openPanel(result);

    expect(result.current.handleKeyDown(keyEvent('ArrowRight'))).toBe(false);
    const ctrlRight = { ...keyEvent('ArrowRight'), ctrlKey: true } as React.KeyboardEvent<HTMLTextAreaElement>;
    act(() => { result.current.handleKeyDown(ctrlRight); });
    expect(result.current.activeTab).toBe('library');
    act(() => { result.current.handleKeyDown(ctrlRight); });
    expect(result.current.activeTab).toBe('files');
    act(() => { result.current.handleKeyDown(ctrlRight); });
    expect(result.current.activeTab).toBe('sessions');
    act(() => { result.current.handleKeyDown(keyEvent('Enter')); });
    expect(onSessionSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'past-1', kind: 'session' }));
    expect(result.current.isOpen).toBe(false);
  });

  it('IME 组合中的 Enter 不触发选择', async () => {
    const { result } = setup();
    await openPanel(result);

    const imeEnter = {
      key: 'Enter',
      preventDefault: vi.fn(),
      nativeEvent: { isComposing: true, keyCode: 229 },
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
    const handled = result.current.handleKeyDown(imeEnter);
    expect(handled).toBe(false);
    expect(mocks.setSessionPin).not.toHaveBeenCalled();
  });

  // FB-586：工作区文件列表拉取失败时 catch 也会 setIsOpen(true)，面板开着但 0 行。
  // 此时裸 Enter 曾一路漏给提交链路，发出一条只有 "@" 的消息。
  function mockEmptySources(): void {
    mocks.listLibraryItems.mockResolvedValue([]);
    mocks.listProjects.mockResolvedValue([]);
    mocks.getProjectArtifacts.mockResolvedValue([]);
    (window as { domainAPI?: unknown }).domainAPI = {
      invoke: vi.fn().mockResolvedValue({ success: true, data: [] }),
    };
  }

  it('空面板（0 行）时裸 Enter 被吞掉并关面板：不再漏给提交链路发出裸 @（FB-586）', async () => {
    mockEmptySources();
    const { result } = setup();
    await openPanel(result);

    expect(result.current.isOpen).toBe(true);
    expect(result.current.flatRows).toHaveLength(0);
    const enter = keyEvent('Enter');
    let handled = false;
    act(() => { handled = result.current.handleKeyDown(enter); });
    expect(handled).toBe(true);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(result.current.isOpen).toBe(false);
  });

  it('空面板 ArrowDown 被吞掉（光标不跳出），随后 Enter 也不再返回 false 漏给提交', async () => {
    mockEmptySources();
    const { result } = setup();
    await openPanel(result);

    const down = keyEvent('ArrowDown');
    let downHandled = false;
    act(() => { downHandled = result.current.handleKeyDown(down); });
    expect(downHandled).toBe(true);
    expect(down.preventDefault).toHaveBeenCalled();
    const enter = keyEvent('Enter');
    let enterHandled: boolean | undefined = true;
    act(() => { enterHandled = result.current.handleKeyDown(enter); });
    expect(enterHandled).not.toBe(false);
    expect(enter.preventDefault).toHaveBeenCalled();
  });

  it('空面板时 IME 组合中的 Enter 仍返回 false：不关面板、不选中、不 preventDefault', async () => {
    mockEmptySources();
    const { result } = setup();
    await openPanel(result);

    const imeEnter = {
      key: 'Enter',
      preventDefault: vi.fn(),
      nativeEvent: { isComposing: true, keyCode: 229 },
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
    expect(result.current.handleKeyDown(imeEnter)).toBe(false);
    expect(imeEnter.preventDefault).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(true);
    expect(mocks.setSessionPin).not.toHaveBeenCalled();
  });

  it('Esc 关闭后面板不因同一段文本再次弹开，Enter 留给提交', async () => {
    const { result } = setup();
    await openPanel(result);

    act(() => { result.current.handleKeyDown(keyEvent('Escape')); });
    expect(result.current.isOpen).toBe(false);

    await act(async () => {
      result.current.search('@', 1);
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(result.current.isOpen).toBe(false);

    const enter = keyEvent('Enter');
    expect(result.current.handleKeyDown(enter)).toBe(false);
    expect(enter.preventDefault).not.toHaveBeenCalled();

    // 文本变了（继续输入 query）则重新打开
    await act(async () => {
      result.current.search('@a', 2);
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(result.current.isOpen).toBe(true);
  });

  it('pin 写库失败时回滚选中态并提示', async () => {
    mocks.setSessionPin.mockRejectedValueOnce(new Error('ipc down'));
    const { result } = setup();
    await openPanel(result);

    act(() => { result.current.handleKeyDown(keyEvent('Enter')); });
    expect(result.current.libraryRows[0]?.pinned).toBe(true);
    await act(async () => { await Promise.resolve(); });
    expect(result.current.libraryRows[0]?.pinned).toBe(false);
    expect(mocks.toast.error).toHaveBeenCalled();
  });

  // ============================================================================
  // N-FIX-EN-ATMENTION-SESSION-ROW-UNSORTED-ZH：未分类桶（proj_unsorted）的 host 存名
  // 是 zh 常量「未分类」，会话行 meta 不得把它直出进英文界面。经真实 hook 拉项目表
  // （listProjects 含桶）+ AtMentionPopover 渲染断言，路径即 refreshReferences →
  // buildSessionRows → AtMentionPopover sessionMeta。
  // ============================================================================
  async function renderSessionMeta(): Promise<string> {
    // 清掉库/文件/产物行，面板里唯一剩下的行就是会话行，第一个按钮内的灰字即其 meta
    mocks.listLibraryItems.mockResolvedValue([]);
    mocks.getProjectArtifacts.mockResolvedValue([]);
    Element.prototype.scrollIntoView = vi.fn();
    useAppStore.setState({ workingDirectory: null });
    const { result } = setup();
    await openPanel(result);
    const view = render(
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
    // 清掉库/文件/产物行后，面板里第一个按钮内的灰字就是会话行 meta
    return view.container.querySelector('button span.text-zinc-500')?.textContent ?? '';
  }

  function mockUnsortedSession(): void {
    mocks.listProjects.mockResolvedValue([{ id: 'proj_unsorted', name: '未分类' }]);
    vi.mocked(window.domainAPI!.invoke).mockImplementation((_domain: string, action: string) => Promise.resolve({
      success: true,
      data: action === 'list' ? [session('past-unsorted', '今日计划', 'proj_unsorted')] : [],
    }));
  }

  it('未分类会话行 meta（en）显示 Unsorted，不含任何中文字符', async () => {
    mocks.language = 'en';
    mockUnsortedSession();
    const meta = await renderSessionMeta();
    expect(meta).toMatch(/6 messages · Unsorted$/);
    expect(meta).not.toMatch(/[一-鿿]/);
    cleanup();
    mocks.language = 'zh';
  });

  it('未分类会话行 meta（zh）仍显示 未分类', async () => {
    mocks.language = 'zh';
    mockUnsortedSession();
    const meta = await renderSessionMeta();
    expect(meta).toMatch(/6 条消息 · 未分类$/);
    cleanup();
  });

  it('普通项目会话行 meta 不受影响（zh：Neo 项目）', async () => {
    mocks.language = 'zh';
    const meta = await renderSessionMeta();
    expect(meta).toMatch(/6 条消息 · Neo 项目$/);
    cleanup();
  });
});

// ============================================================================
// FB-1531 回归：@ 面板的「工作区文件」来自会话/项目工作目录，绝不落到 host 进程 cwd。
// 真实 host 的 handleListFiles 对任何非工作目录路径返回宿主进程 cwd 的内容，
// 这里用 mock 复刻该语义：没命中工作目录前缀的一律吐 build-info.json / dist（宿主泄漏源）。
// ============================================================================
describe('useAtMentionPanel 工作目录来源（FB-1531）', () => {
  const HOST_CWD_LEAK = [
    { name: 'build-info.json', path: 'build-info.json', isDirectory: false },
    { name: 'dist', path: 'dist', isDirectory: true },
  ];

  interface DirHandler {
    prefix: string;
    data: Array<{ name: string; path: string; isDirectory?: boolean }>;
  }

  function mockWorkspaceHost(dirHandlers: DirHandler[]) {
    const invoke = vi.fn().mockImplementation((_domain: string, action: string, payload?: { dirPath?: string }) => {
      if (action === 'listFiles') {
        const dirPath = payload?.dirPath ?? '';
        const handler = dirHandlers.find((candidate) => dirPath.startsWith(candidate.prefix));
        return Promise.resolve({ success: true, data: handler ? handler.data : HOST_CWD_LEAK });
      }
      return Promise.resolve({ success: true, data: [] });
    });
    (window as { domainAPI?: unknown }).domainAPI = { invoke };
    return invoke;
  }

  function listFilesCalls(invoke: ReturnType<typeof mockWorkspaceHost>): Array<{ dirPath: string }> {
    return invoke.mock.calls
      .filter((call) => call[1] === 'listFiles')
      .map((call) => (call[2] ?? {}) as { dirPath: string });
  }

  function sessionWithDir(id: string, workingDirectory: string | null): SessionWithMeta {
    return {
      id,
      title: id,
      modelConfig: {} as SessionWithMeta['modelConfig'],
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      workingDirectory,
    } as SessionWithMeta;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.listLibraryItems.mockResolvedValue([]);
    mocks.getSessionPin.mockResolvedValue({ sessionId: 'session-1', itemIds: [] });
    mocks.listProjects.mockResolvedValue([]);
    mocks.getProjectArtifacts.mockResolvedValue([]);
    useAppStore.setState({ workingDirectory: null });
    useSessionStore.setState({ sessions: [], currentSessionId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    useAppStore.setState({ workingDirectory: null });
    useSessionStore.setState({ sessions: [], currentSessionId: null });
  });

  function setup() {
    return renderHook(() => useAtMentionPanel({
      sessionId: 'session-1',
      projectId: null,
      onFileSelect: vi.fn(),
      onSessionSelect: vi.fn(),
      onArtifactSelect: vi.fn(),
      onLibrarySelect: vi.fn(),
    }));
  }

  async function openPanel(result: { current: ReturnType<typeof useAtMentionPanel> }, text: string) {
    await act(async () => {
      result.current.search(text, text.length);
      await vi.advanceTimersByTimeAsync(250);
    });
  }

  it('(a) 工作目录 /tmp/proj-a：文件行只有 notes.md，listFiles 的 dirPath 指向 /tmp/proj-a 而非宿主 cwd', async () => {
    useAppStore.setState({ workingDirectory: '/tmp/proj-a' });
    const invoke = mockWorkspaceHost([
      { prefix: '/tmp/proj-a', data: [{ name: 'notes.md', path: '/tmp/proj-a/notes.md', isDirectory: false }] },
    ]);
    const { result } = setup();
    await openPanel(result, '@');

    expect(result.current.isOpen).toBe(true);
    expect(result.current.fileRows.map((row) => row.name)).toEqual(['notes.md']);
    const calls = listFilesCalls(invoke);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.dirPath).toBe('/tmp/proj-a');
    expect(calls[0]?.dirPath.startsWith('/tmp/proj-a')).toBe(true);
    // 旧实现把 '.' 传给 host → 宿主 cwd 的 build-info.json / dist 会混进来
    expect(result.current.fileRows.some((row) => row.name === 'build-info.json' || row.name === 'dist')).toBe(false);
  });

  it('(b) 工作目录为空目录：0 文件行，面板仍打开（不吐宿主 cwd 的文件）', async () => {
    useAppStore.setState({ workingDirectory: '/tmp/empty-proj' });
    const invoke = mockWorkspaceHost([{ prefix: '/tmp/empty-proj', data: [] }]);
    const { result } = setup();
    await openPanel(result, '@');

    expect(result.current.isOpen).toBe(true);
    expect(result.current.fileRows).toHaveLength(0);
    expect(listFilesCalls(invoke)[0]?.dirPath).toBe('/tmp/empty-proj');
  });

  it('(c) 无工作目录（appStore 与会话都为 null）：不发 listFiles，面板仍打开', async () => {
    useSessionStore.setState({ sessions: [sessionWithDir('session-1', null)] });
    const invoke = mockWorkspaceHost([]);
    const { result } = setup();
    await openPanel(result, '@');

    expect(result.current.isOpen).toBe(true);
    expect(listFilesCalls(invoke)).toHaveLength(0);
  });

  it('(c2) appStore 无目录但当前会话有：回退用会话的 workingDirectory', async () => {
    useAppStore.setState({ workingDirectory: null });
    useSessionStore.setState({
      sessions: [sessionWithDir('session-1', '/tmp/session-dir')],
      currentSessionId: 'session-1',
    });
    const invoke = mockWorkspaceHost([
      { prefix: '/tmp/session-dir', data: [{ name: 'draft.md', path: '/tmp/session-dir/draft.md', isDirectory: false }] },
    ]);
    const { result } = setup();
    await openPanel(result, '@');

    expect(result.current.fileRows.map((row) => row.name)).toEqual(['draft.md']);
    expect(invoke).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'listFiles', { dirPath: '/tmp/session-dir' });
  });

  it('(d) query 含 "/"：列 <base>/src（@src/ 浏览 src）', async () => {
    useAppStore.setState({ workingDirectory: '/tmp/proj-a' });
    const invoke = mockWorkspaceHost([
      { prefix: '/tmp/proj-a/src/', data: [{ name: 'foo.ts', path: '/tmp/proj-a/src/foo.ts', isDirectory: false }] },
    ]);
    const { result } = setup();
    await openPanel(result, '@src/');

    expect(invoke).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'listFiles', { dirPath: '/tmp/proj-a/src/' });
    expect(result.current.fileRows.map((row) => row.name)).toEqual(['foo.ts']);
  });

  it('(e) query 是绝对路径 @/abs/dir/：直接列该目录，不拼成 <base>//abs（Rework r1）', async () => {
    useAppStore.setState({ workingDirectory: '/tmp/proj-a' });
    const invoke = mockWorkspaceHost([
      { prefix: '/Users/me/Documents/', data: [{ name: 'a.md', path: '/Users/me/Documents/a.md', isDirectory: false }] },
    ]);
    const { result } = setup();
    await openPanel(result, '@/Users/me/Documents/');

    expect(invoke).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'listFiles', { dirPath: '/Users/me/Documents/' });
    expect(result.current.fileRows.map((row) => row.name)).toEqual(['a.md']);
  });

  it('(f) 灰色目录行相对工作目录：/tmp/proj-a/src/foo.ts 显示 src，根下文件无目录；选中仍是绝对路径（Rework r2）', async () => {
    useAppStore.setState({ workingDirectory: '/tmp/proj-a' });
    mockWorkspaceHost([
      {
        prefix: '/tmp/proj-a',
        data: [
          { name: 'foo.ts', path: '/tmp/proj-a/src/foo.ts', isDirectory: false },
          { name: 'notes.md', path: '/tmp/proj-a/notes.md', isDirectory: false },
        ],
      },
    ]);
    const onFileSelect = vi.fn();
    const { result } = renderHook(() => useAtMentionPanel({
      sessionId: 'session-1',
      projectId: null,
      onFileSelect,
      onSessionSelect: vi.fn(),
      onArtifactSelect: vi.fn(),
      onLibrarySelect: vi.fn(),
    }));
    await openPanel(result, '@');

    expect(result.current.fileRows.map((row) => [row.name, row.dir])).toEqual([
      ['foo.ts', 'src'],
      ['notes.md', ''],
    ]);
    expect(result.current.fileRows.map((row) => row.path)).toEqual(['/tmp/proj-a/src/foo.ts', '/tmp/proj-a/notes.md']);
  });
});

describe('buildSessionRows 无项目时 projectName 是文件夹名', () => {
  function directorySession(
    id: string,
    fields: { projectId?: string; workspace?: string; workingDirectory?: string; title?: string } = {},
  ): Session & { messageCount: number } {
    return {
      id,
      title: fields.title ?? '设计回顾',
      ...(fields.projectId ? { projectId: fields.projectId } : {}),
      ...(fields.workspace !== undefined ? { workspace: fields.workspace } : {}),
      ...(fields.workingDirectory !== undefined ? { workingDirectory: fields.workingDirectory } : {}),
      modelConfig: {} as Session['modelConfig'],
      createdAt: 1,
      updatedAt: 2,
      messageCount: 4,
    };
  }

  it('(a) 无 projectId、无 workspace、workingDirectory 为绝对路径时 projectName 等于文件夹名', () => {
    const rows = buildSessionRows([
      directorySession('s-wd', { workingDirectory: '/Users/example/work/my-project' }),
    ], new Map(), '', null);
    expect(rows[0]?.projectName).toBe('my-project');
  });

  it('(b) workspace 为绝对路径时 projectName 是该路径的文件夹名', () => {
    const rows = buildSessionRows([
      directorySession('s-ws', {
        workspace: '/Users/example/work/demo-app',
        workingDirectory: '/Users/example/work/my-project',
      }),
    ], new Map(), '', null);
    expect(rows[0]?.projectName).toBe('demo-app');
  });

  it('(c) 尾部分隔符与 Windows 路径都只留文件夹名', () => {
    const rows = buildSessionRows([
      directorySession('s-win', { workingDirectory: 'C:\\Users\\example\\my-project\\' }),
    ], new Map(), '', null);
    expect(rows[0]?.projectName).toBe('my-project');
  });

  it('(d) projectId 在名称表里时仍用项目名，不退回目录', () => {
    const rows = buildSessionRows([
      directorySession('s-proj', {
        projectId: 'proj-1',
        workspace: '/Users/example/work/demo-app',
        workingDirectory: '/Users/example/work/my-project',
      }),
    ], new Map([['proj-1', 'Neo 项目']]), '', null);
    expect(rows[0]?.projectName).toBe('Neo 项目');
  });

  it('(e) workspace 与 workingDirectory 都空时 projectName 是空串', () => {
    const rows = buildSessionRows([
      directorySession('s-empty'),
    ], new Map(), '', null);
    expect(rows[0]?.projectName).toBe('');
  });

  it('(f) 按文件夹名能搜到，主目录段不再命中', () => {
    const sessions = [
      directorySession('s-search', { workingDirectory: '/Users/example/work/my-project' }),
    ];
    expect(buildSessionRows(sessions, new Map(), 'my-proj', null).map((row) => row.id)).toEqual(['s-search']);
    expect(buildSessionRows(sessions, new Map(), 'users', null)).toEqual([]);
  });
});

describe('AtMentionPopover 会话行 meta 只显示文件夹名', () => {
  const PAST_DIR = '/Users/example/work/my-project';

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.language = 'zh';
    mocks.listLibraryItems.mockResolvedValue([]);
    mocks.getSessionPin.mockResolvedValue({ sessionId: 'current', itemIds: [] });
    mocks.listProjects.mockResolvedValue([]);
    mocks.getProjectArtifacts.mockResolvedValue([]);
    useAppStore.setState({ workingDirectory: null });
    useSessionStore.setState({ sessions: [], currentSessionId: 'current' });
    (window as { domainAPI?: unknown }).domainAPI = {
      invoke: vi.fn().mockImplementation((_domain: string, action: string) => Promise.resolve({
        success: true,
        data: action === 'list'
          ? [{
              id: 'past-dir',
              title: '设计回顾',
              workingDirectory: PAST_DIR,
              modelConfig: {},
              createdAt: 1,
              updatedAt: Date.now(),
              messageCount: 4,
            }]
          : [],
      })),
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    mocks.language = 'zh';
    useAppStore.setState({ workingDirectory: null });
    useSessionStore.setState({ sessions: [], currentSessionId: null });
  });

  async function renderedMeta(language: 'zh' | 'en'): Promise<string> {
    mocks.language = language;
    const { result } = renderHook(() => useAtMentionPanel({
      sessionId: 'current',
      projectId: null,
      onFileSelect: vi.fn(),
      onSessionSelect: vi.fn(),
      onArtifactSelect: vi.fn(),
      onLibrarySelect: vi.fn(),
    }));
    await act(async () => {
      result.current.search('@', 1);
      await vi.advanceTimersByTimeAsync(250);
    });
    const view = render(
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
    const meta = view.container.querySelector('button span.text-zinc-500');
    return meta?.textContent ?? '';
  }

  it('输入 @ 后，无项目的会话行 meta 显示文件夹名（zh / en）', async () => {
    expect(await renderedMeta('zh')).toBe('刚刚 · 4 条消息 · my-project');
    cleanup();
    expect(await renderedMeta('en')).toBe('just now · 4 messages · my-project');
  });
});
