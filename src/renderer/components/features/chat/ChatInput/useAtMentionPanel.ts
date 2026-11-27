// ============================================================================
// useAtMentionPanel - @ 触发面板（WorkBuddy 形态）的数据与键盘导航
// ============================================================================
//
// 2026-07-29 UX round2 任务 14：替代旧 useFileAutocomplete（hooks/ 下已删）。
// - 触发规则不变：光标前文本尾部匹配 /@([^\s@]*)$/，200ms 防抖拉工作区文件。
// - 面板打开时（每次 false→true）拉资料库条目 + 本会话 pin，客户端过滤
//   （filterPinCandidates / matchesLibraryItemSearch）。资料库行选中 = 幂等钉上并关闭。
// - 键盘导航（↑↓ 跨组循环 / Enter 选中 / Esc 关闭）经 onAutocompleteKeyDown
//   接进 InputArea，Enter 用 imeCompositionGuard 防中文输入法上屏误选。
// pin 写库乐观更新、失败回滚，并广播 libraryPinEvents 让 PinnedLibraryChips 即时刷新。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { LibraryItem } from '@shared/contract/library';
import type { Message } from '@shared/contract/message';
import type { ProjectArtifact } from '@shared/contract/project';
import type { Session } from '@shared/contract/session';
import { getSessionPin, listLibraryItems, setSessionPin } from '../../../../services/libraryClient';
import { getProjectArtifacts, listProjects } from '../../../../services/projectClient';
import { useAppStore } from '../../../../stores/appStore';
import { useComposerStore } from '../../../../stores/composerStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { notifyLibraryPinChanged } from '../../knowledge/libraryPinEvents';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import { getProjectDisplayName } from '../../../../utils/projectDisplayName';
import { isImeKeyEvent, useImeCompositionRef } from './imeCompositionGuard';
import {
  buildArtifactRows,
  buildFileRows,
  buildLibraryRows,
  buildSessionRows,
  flattenAtMentionRows,
  groupLimitForTab,
  mergeSessionAttachmentRows,
  shiftAtMentionTab,
  wrapIndex,
  type AtMentionArtifactRow,
  type AtMentionFileMatch,
  type AtMentionFileRow,
  type AtMentionLibraryRow,
  type AtMentionRow,
  type AtMentionSessionRow,
  type AtMentionTab,
} from './atMentionPanelModel';

const AT_TRIGGER_RE = /@([^\s@]*)$/;
const NO_MESSAGES: readonly Message[] = [];

// FB-1531：@ 面板的「工作区文件」必须来自会话/项目的工作目录，而不是 host 进程 cwd。
// host 的 handleListFiles 直接 fs.readdir(payload.dirPath)，传裸 '.' 会列到 host 进程自己的
// 目录（空项目里却列出宿主的 build-info.json/dist）。基目录与文件行选中的口径一致：
// appStore.workingDirectory 优先，其次当前会话的 workingDirectory，两者皆无返回 null。
function resolveAtMentionBaseDir(sessionId: string | null): string | null {
  const fromSession = sessionId
    ? useSessionStore.getState().sessions.find((session) => session.id === sessionId)?.workingDirectory ?? null
    : null;
  return useAppStore.getState().workingDirectory ?? fromSession;
}

/** '@' 后的 query → 要列的目录：含 '/' 时列 <base>/<最后一个 '/' 及之前>（@src/ 浏览 src），否则列 base。
 *  base 来自会话/项目工作目录（绝对路径），绝不给 host 传裸相对路径。 */
function atMentionListDir(baseDir: string, searchQuery: string): string {
  const base = baseDir.endsWith('/') ? baseDir.slice(0, -1) : baseDir;
  const slashIndex = searchQuery.lastIndexOf('/');
  if (slashIndex < 0) return base;
  // query 本身是绝对路径（@/abs/dir/、选中目录行后插入的 @/tmp/proj/src）：直接列它，不拼 base（否则 <base>//abs 被 host 吞错成 []）
  if (/^(\/|[A-Za-z]:[\\/])/.test(searchQuery)) return searchQuery.slice(0, slashIndex + 1);
  return `${base}/${searchQuery.slice(0, slashIndex + 1)}`;
}

async function listWorkspaceFiles(dirPath: string): Promise<AtMentionFileMatch[]> {
  const response = await window.domainAPI?.invoke<Array<{ name: string; path?: string; isDirectory?: boolean }>>(
    IPC_DOMAINS.WORKSPACE,
    'listFiles',
    { dirPath },
  );
  if (!response?.success) {
    throw new Error(response?.error?.message || 'Failed to list workspace files');
  }
  return (response.data ?? []).map((entry) => ({
    path: entry.path || entry.name,
    name: entry.name,
    isDirectory: Boolean(entry.isDirectory),
  }));
}

export interface UseAtMentionPanelParams {
  /**
   * 有会话：pin 读写 host getSessionPin/setSessionPin。
   * 无会话（草稿/空间槽）：pin 意图写 composerStore.pendingPinItemIds，创建会话时物化。
   */
  sessionId: string | null;
  /** 当前项目（pin 候选口径：本项目 ∪ 全局架）；空间页由 scopeProjectId 传入。 */
  projectId: string | null;
  /** 文件行选中后的插入动作（组件持有：文件 → 内联 chip + 附件；目录 → 保留 @path 文本）。 */
  onFileSelect: (row: AtMentionFileRow) => void;
  onSessionSelect: (row: AtMentionSessionRow) => void;
  onArtifactSelect: (row: AtMentionArtifactRow) => void;
  /** 资料库行选中后清掉光标前的 @query。chip 由 pin → 内联 chip 对账补上，这里不插第二颗。 */
  onLibrarySelect: (row: AtMentionLibraryRow) => void;
}

export function useAtMentionPanel(params: UseAtMentionPanelParams) {
  const { sessionId, projectId, onFileSelect, onSessionSelect, onArtifactSelect, onLibrarySelect } = params;
  const { t } = useI18n();
  const isComposingRef = useImeCompositionRef();
  const pendingPinItemIds = useComposerStore((s) => s.pendingPinItemIds);
  // FB-3095：会话附件候选只对「面板所在会话 = 当前会话」生效——sessionStore.messages
  // 是 currentSessionId 的消息列表，别的会话不能拿它凑候选。响应式订阅 messages：
  // 切走再切回、或新消息附件落库后行即时更新。
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessionMessages = useSessionStore((s) => s.messages);
  const sessionAttachmentMessages = sessionId && sessionId === currentSessionId ? sessionMessages : NO_MESSAGES;

  const [files, setFiles] = useState<AtMentionFileMatch[]>([]);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [sessions, setSessions] = useState<Array<Session & { messageCount?: number }>>([]);
  const [artifacts, setArtifacts] = useState<ProjectArtifact[]>([]);
  const [projectNames, setProjectNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [sessionPinnedIds, setSessionPinnedIds] = useState<ReadonlySet<string>>(new Set());
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<AtMentionTab>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const pendingSearchRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Esc 关闭后记录当前文本：文本不变就不因下一次 search 调用把面板弹回来
  // （与 agent mention 的 dismissedAgentAutocompleteValue 同一思路）。
  const dismissedTextRef = useRef<string | null>(null);
  const lastTextRef = useRef('');
  const wasOpenRef = useRef(false);
  // onFileSelect 依赖组件的 value/query，每次按键都变；经 ref 调最新版，避免 hook 内回调链全跟着重建。
  const onFileSelectRef = useRef(onFileSelect);
  onFileSelectRef.current = onFileSelect;
  const onSessionSelectRef = useRef(onSessionSelect);
  onSessionSelectRef.current = onSessionSelect;
  const onArtifactSelectRef = useRef(onArtifactSelect);
  onArtifactSelectRef.current = onArtifactSelect;
  const onLibrarySelectRef = useRef(onLibrarySelect);
  onLibrarySelectRef.current = onLibrarySelect;

  const pinnedIds = useMemo(
    () => (sessionId ? sessionPinnedIds : new Set(pendingPinItemIds)),
    [sessionId, sessionPinnedIds, pendingPinItemIds],
  );

  const refreshLibrary = useCallback(async (targetSessionId: string | null) => {
    try {
      if (targetSessionId) {
        const [all, pin] = await Promise.all([listLibraryItems(), getSessionPin(targetSessionId)]);
        setLibraryItems(all);
        setSessionPinnedIds(new Set(pin.itemIds));
      } else {
        const all = await listLibraryItems();
        setLibraryItems(all);
        // 草稿/空间 pin 意图由 composerStore.pendingPinItemIds 驱动，不在这里覆写
      }
    } catch {
      // 资料库不可用时静默降级为纯文件面板（与旧行为一致）
      setLibraryItems([]);
      if (targetSessionId) setSessionPinnedIds(new Set());
    }
  }, []);

  const refreshReferences = useCallback(async (targetProjectId: string | null) => {
    const [sessionsResult, projectsResult, artifactsResult] = await Promise.allSettled([
      window.domainAPI?.invoke<Array<Session & { messageCount?: number }>>(
        IPC_DOMAINS.SESSION,
        'list',
        { includeArchived: true, limit: 50 },
      ),
      listProjects(true),
      targetProjectId ? getProjectArtifacts(targetProjectId, 50) : Promise.resolve([]),
    ]);
    setSessions(
      sessionsResult.status === 'fulfilled' && sessionsResult.value?.success
        ? sessionsResult.value.data ?? []
        : [],
    );
    // 未分类桶的 host 存名是 zh 常量「未分类」，直出会漏进英文界面；按 id 换 i18n 文案
    setProjectNames(new Map(
      projectsResult.status === 'fulfilled'
        ? projectsResult.value.map((project) => [project.id, getProjectDisplayName(project, t)])
        : [],
    ));
    setArtifacts(artifactsResult.status === 'fulfilled' ? artifactsResult.value : []);
  }, [t]);

  // 换会话后 pin 是真源在会话上的，重拉一次避免拿上个会话的选中态
  useEffect(() => {
    setLibraryItems([]);
    setSessionPinnedIds(new Set());
    if (wasOpenRef.current) {
      void refreshLibrary(sessionId);
      void refreshReferences(projectId);
    }
  }, [projectId, refreshLibrary, refreshReferences, sessionId]);

  const search = useCallback((text: string, cursorPos: number) => {
    // 先取消上一次挂起的防抖请求，否则清空输入后它仍会回调 setIsOpen(true) 把 popup 弹回来。
    clearTimeout(pendingSearchRef.current);
    pendingSearchRef.current = undefined;
    lastTextRef.current = text;

    const beforeCursor = text.slice(0, cursorPos);
    const atMatch = beforeCursor.match(AT_TRIGGER_RE);

    if (!atMatch) {
      setIsOpen(false);
      setFiles([]);
      dismissedTextRef.current = null;
      return;
    }

    if (dismissedTextRef.current === text) {
      setIsOpen(false);
      return;
    }

    const searchQuery = atMatch[1];
    setQuery(searchQuery);

    // 面板 false→true：拉/刷新资料库条目与 pin（pin 可能被 chips 行 × 掉过）
    // 草稿/空间同样拉库，pin 意图挂 composer 槽
    if (!wasOpenRef.current) {
      void refreshLibrary(sessionId);
      void refreshReferences(projectId);
    }

    const timer = setTimeout(async () => {
      const baseDir = resolveAtMentionBaseDir(sessionId);
      let entries: AtMentionFileMatch[] = [];
      if (baseDir) {
        try {
          entries = await listWorkspaceFiles(atMentionListDir(baseDir, searchQuery));
        } catch {
          entries = [];
        }
      }
      if (pendingSearchRef.current !== timer) return;
      // 无工作目录（草稿/空间槽）也不发 listFiles：files 恒空，面板仍打开展示其他组
      setFiles(entries);
      setIsOpen(true);
      pendingSearchRef.current = undefined;
      wasOpenRef.current = true;
    }, 200);
    pendingSearchRef.current = timer;
  }, [projectId, refreshLibrary, refreshReferences, sessionId]);

  const dismiss = useCallback((untilTextChange = false) => {
    clearTimeout(pendingSearchRef.current);
    pendingSearchRef.current = undefined;
    if (untilTextChange) dismissedTextRef.current = lastTextRef.current;
    setIsOpen(false);
    wasOpenRef.current = false;
  }, []);

  // 选中只保证钉上，绝不取消。取消只走 chip ×（removePin）。已钉住时不再写一遍。
  const ensurePinned = useCallback((itemId: string) => {
    if (!sessionId) {
      const store = useComposerStore.getState();
      if (store.pendingPinItemIds.includes(itemId)) return;
      store.setPendingPinItemIds([...store.pendingPinItemIds, itemId]);
      return;
    }
    // 面板内的 pin 集合可能过期（chip × 在面板开着时取消过），以 host 现状为准再决定写不写。
    const prev = sessionPinnedIds;
    if (!prev.has(itemId)) {
      setSessionPinnedIds(new Set(prev).add(itemId));
      notifyLibraryPinChanged(sessionId);
    }
    void (async () => {
      try {
        const fresh = await getSessionPin(sessionId);
        if (fresh.itemIds.includes(itemId)) return;
        const next = [...fresh.itemIds, itemId];
        await setSessionPin(sessionId, next);
        setSessionPinnedIds(new Set(next));
        notifyLibraryPinChanged(sessionId);
      } catch {
        setSessionPinnedIds(prev);
        notifyLibraryPinChanged(sessionId);
        toast.error(t.library.pinFailed);
      }
    })();
  }, [sessionPinnedIds, sessionId, t]);

  const groupLimit = groupLimitForTab(activeTab);
  const libraryRows = useMemo(
    () => activeTab === 'all' || activeTab === 'library'
      ? buildLibraryRows(libraryItems, projectId, pinnedIds, query, groupLimit)
      : [],
    [activeTab, groupLimit, libraryItems, projectId, pinnedIds, query],
  );
  // 文件名过滤只取最后一个 '/' 之后的部分：@src/fo 应列 <base>/src 再按 'fo' 过滤；
  // 整个 query 当子串会把 'src/' 也算进文件名，@src/ 会一行都不剩（浏览子目录就废了）。
  const fileNameFilter = query.slice(query.lastIndexOf('/') + 1);
  // FB-3095：文件组 = 本会话附件（query 无 '/' 时、与工作区文件同一文件名过滤口径、新上传在前）
  // + 工作区文件。附件候选在工作目录之外也成立（无 baseDir 时 files 恒空、附件仍进列表）。
  const fileRows = useMemo(
    () => activeTab === 'all' || activeTab === 'files'
      ? mergeSessionAttachmentRows(
          sessionAttachmentMessages,
          buildFileRows(files, fileNameFilter, groupLimit, resolveAtMentionBaseDir(sessionId)),
          query,
          groupLimit,
        )
      : [],
    [activeTab, fileNameFilter, files, groupLimit, query, sessionAttachmentMessages, sessionId],
  );
  const sessionRows = useMemo(
    () => activeTab === 'all' || activeTab === 'sessions'
      ? buildSessionRows(sessions, projectNames, query, sessionId, groupLimit)
      : [],
    [activeTab, groupLimit, projectNames, query, sessionId, sessions],
  );
  const artifactRows = useMemo(
    () => activeTab === 'all' || activeTab === 'artifacts' ? buildArtifactRows(artifacts, query, groupLimit) : [],
    [activeTab, artifacts, groupLimit, query],
  );
  const flatRows = useMemo(
    () => flattenAtMentionRows(libraryRows, fileRows, sessionRows, artifactRows),
    [artifactRows, fileRows, libraryRows, sessionRows],
  );

  // query / 结果集变化后高亮回第一行（与 SlashCommandPopover 的 filter 复位一致）
  useEffect(() => {
    setSelectedIndex(0);
  }, [activeTab, query, flatRows.length]);

  const selectRow = useCallback((row: AtMentionRow) => {
    if (row.kind === 'file') {
      onFileSelectRef.current(row);
      dismiss();
      return;
    }
    if (row.kind === 'session') {
      onSessionSelectRef.current(row);
      dismiss();
      return;
    }
    if (row.kind === 'artifact') {
      onArtifactSelectRef.current(row);
      dismiss();
      return;
    }
    // 资料库行 = 幂等钉上 + 关掉面板。触发词由组件清掉；再带一条要重新输入 @。
    ensurePinned(row.item.id);
    onLibrarySelectRef.current(row);
    dismiss();
  }, [dismiss, ensurePinned]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>): boolean => {
    const isSelectionEnter = e.key === 'Enter' && !e.shiftKey && !isImeKeyEvent(e.nativeEvent, isComposingRef);
    if (!isOpen && pendingSearchRef.current !== undefined && isSelectionEnter) {
      // Swallow Enter while results load so it cannot send a half-written @ reference.
      e.preventDefault();
      return true;
    }
    if (!isOpen) return false;

    // FB-586：工作区列表拉取失败时面板可能开着但 0 行。方向键在这里吞掉，
    // 不让光标跳出输入框。
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flatRows.length === 0) return true;
      setSelectedIndex((prev) => wrapIndex(prev, 1, flatRows.length));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flatRows.length === 0) return true;
      setSelectedIndex((prev) => wrapIndex(prev, -1, flatRows.length));
      return true;
    }
    if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      setActiveTab((tab) => shiftAtMentionTab(tab, e.key === 'ArrowRight' ? 1 : -1));
      return true;
    }
    // IME 组合中的 Enter 是确认候选词（如中文选字），不能当成选择面板项
    if (isSelectionEnter) {
      const selected = flatRows[Math.min(selectedIndex, flatRows.length - 1)];
      if (selected) {
        e.preventDefault();
        selectRow(selected);
        return true;
      }
      // FB-586：0 行面板把裸 Enter 漏给提交链路会发出一条只有 "@" 的消息。
      // 吞掉 Enter 并关面板（文本原样保留，再按一次 Enter 正常发送，用户不会被卡住）。
      e.preventDefault();
      dismiss(true);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss(true);
      return true;
    }
    return false;
  }, [dismiss, flatRows, isComposingRef, isOpen, selectRow, selectedIndex]);

  return {
    isOpen,
    query,
    activeTab,
    setActiveTab,
    libraryRows,
    fileRows,
    sessionRows,
    artifactRows,
    flatRows,
    selectedIndex,
    setSelectedIndex,
    search,
    dismiss,
    selectRow,
    handleKeyDown,
  };
}

export type { AtMentionArtifactRow, AtMentionFileRow, AtMentionLibraryRow, AtMentionRow, AtMentionSessionRow, AtMentionTab };
