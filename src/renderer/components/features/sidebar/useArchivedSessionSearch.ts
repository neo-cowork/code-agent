// 搜索弹窗的「包含已归档」：弹窗本地状态，不碰侧栏的 SessionFilter。
// 空查询 → archivedOnly 列表；有查询 → SESSION_SEARCH(includeArchived) 里只取归档命中。
import { useCallback, useEffect, useRef, useState } from 'react';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import { SESSION_LIST_PAGE_SIZE, UI } from '@shared/constants';
import type { Session } from '@shared/contract';
import type { CrossSessionSearchProjectScope, CrossSessionSearchResults } from '@shared/ipc/types';
import type { SessionWithMeta } from '../../../stores/sessionStore';
import type { SidebarSearchScope } from '../../../utils/sidebarMessageSearch';
import ipcService from '../../../services/ipcService';
import { createLogger } from '../../../utils/logger';

const logger = createLogger('SidebarArchivedSearch');

export interface ArchivedSessionSearch {
  archivedRows: SessionWithMeta[];
  loading: boolean;
  /** 空查询列表还有下一页（archivedOnly 分页） */
  hasMore: boolean;
  loadMore: () => void;
  removeArchivedRow: (sessionId: string) => void;
}

interface Params {
  enabled: boolean;
  query: string;
  scope: SidebarSearchScope;
  /** 当前会话的项目标识；current-project 范围用它收窄 */
  project: { projectId?: string; workingDirectory?: string } | null;
}

function toArchivedRow(session: Pick<Session, 'id' | 'title' | 'updatedAt'> & Partial<SessionWithMeta>): SessionWithMeta {
  return {
    messageCount: 0,
    turnCount: 0,
    ...session,
    createdAt: session.createdAt ?? session.updatedAt,
    isArchived: true,
  } as SessionWithMeta;
}

export function useArchivedSessionSearch({ enabled, query, scope, project }: Params): ArchivedSessionSearch {
  const [archivedRows, setArchivedRows] = useState<SessionWithMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  // 已从 host 取出的原始条数（含被「本项目」收窄丢掉的）：下一页 offset；恢复一条就少一条归档行。
  const rawLoadedRef = useRef(0);
  const loadMoreRef = useRef<() => void>(() => {});
  const trimmed = query.trim();
  const projectId = project?.projectId?.trim() || '';
  const workingDirectory = project?.workingDirectory?.trim() || '';
  const scopeKeyRef = useRef('');
  const narrow = scope === 'current-project' && (projectId || workingDirectory);

  const scopeKey = JSON.stringify([enabled, narrow ? (projectId ? { projectId } : { workingDirectory }) : null]);

  useEffect(() => {
    rawLoadedRef.current = 0;
    setHasMore(false);
    // 范围/开关变了：上一范围的行立刻作废，否则旧行（可能属于别的项目）在新请求回来前仍可点「恢复」。
    if (scopeKeyRef.current !== scopeKey) setArchivedRows([]);
    scopeKeyRef.current = scopeKey;
    if (!enabled) {
      setArchivedRows([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    const projectScope: CrossSessionSearchProjectScope | undefined = narrow
      ? (projectId ? { projectId } : { workingDirectory })
      : undefined;
    const fetchArchivedPage = (offset: number) =>
      ipcService
        // 项目收窄在 host SQL 层做（分页之前），否则本项目的归档会被全局归档页摊薄、翻不到
        .invokeDomain<Session[]>(IPC_DOMAINS.SESSION, 'list', {
          archivedOnly: true,
          limit: SESSION_LIST_PAGE_SIZE,
          offset,
          ...(projectScope ? { projectScope } : {}),
        })
        .then((list) => {
          const page = list ?? [];
          // 已作废（范围/查询变了）的请求不得改 offset / hasMore，否则下一次加载更多会跳页
          if (!cancelled) {
            rawLoadedRef.current = offset + page.length;
            setHasMore(page.length >= SESSION_LIST_PAGE_SIZE);
          }
          return { rows: page.map((s) => toArchivedRow(s)) };
        });
    loadMoreRef.current = () => {
      setLoading(true);
      fetchArchivedPage(rawLoadedRef.current)
        .then(({ rows }) => {
          if (cancelled) return;
          setArchivedRows((current) => {
            const known = new Set(current.map((row) => row.id));
            return [...current, ...rows.filter((row) => !known.has(row.id))].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          });
        })
        .catch((error) => logger.warn('Archived session page failed', { errorMessage: error instanceof Error ? error.message : String(error) }))
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    const timer = setTimeout(() => {
      setLoading(true);
      const request: Promise<SessionWithMeta[]> = trimmed
        ? ipcService
            .invoke(IPC_CHANNELS.SESSION_SEARCH, {
              query: trimmed,
              options: { limit: 80, includeArchived: true, ...(projectScope ? { projectScope } : {}) },
            })
            .then((raw) => {
              const results = raw as CrossSessionSearchResults | null | undefined;
              if (!results || !Array.isArray(results.results)) throw new Error('SESSION_SEARCH returned no result payload');
              const rows = new Map<string, SessionWithMeta>();
              for (const item of results.results) {
                if (item.sessionArchived !== true || item.sessionTitle === undefined || rows.has(item.sessionId)) continue;
                rows.set(item.sessionId, toArchivedRow({ id: item.sessionId, title: item.sessionTitle, updatedAt: item.sessionUpdatedAt ?? item.timestamp }));
              }
              for (const match of results.titleMatches ?? []) {
                if (match.archived && !rows.has(match.sessionId)) {
                  rows.set(match.sessionId, toArchivedRow({ id: match.sessionId, title: match.title, updatedAt: match.updatedAt }));
                }
              }
              return Array.from(rows.values());
            })
        : fetchArchivedPage(0).then(({ rows }) => rows);
      request
        .then((rows) => {
          if (!cancelled) setArchivedRows(rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
        })
        .catch((error) => {
          if (cancelled) return;
          logger.warn('Archived session search failed', { errorMessage: error instanceof Error ? error.message : String(error) });
          setArchivedRows([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, trimmed ? UI.DEBOUNCE_DELAY : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, trimmed, narrow, projectId, workingDirectory]);

  const removeArchivedRow = useCallback((sessionId: string) => {
    setArchivedRows((rows) => {
      if (rows.some((row) => row.id === sessionId)) rawLoadedRef.current = Math.max(0, rawLoadedRef.current - 1);
      return rows.filter((row) => row.id !== sessionId);
    });
  }, []);
  const loadMore = useCallback(() => loadMoreRef.current(), []);

  return { archivedRows, loading, hasMore, loadMore, removeArchivedRow };
}
