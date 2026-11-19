import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectWithActivity } from '@shared/contract/project';
import { listProjectsWithActivity } from '../../../services/projectClient';
import { subscribeProjectSpaceList } from '../../../services/projectSpaceListEvents';
import { useSessionStore } from '../../../stores/sessionStore';

export interface EmptyCollaborationSpaces {
  spaces: ProjectWithActivity[];
  /** 空间被改名、归档、删除后递增，用来重拉仍在列表里的空间详情。 */
  revision: number;
}

/**
 * 侧栏空协作空间目录。listProjectsWithActivity 缺失或失败时当作没有空空间，
 * 避免摘要风暴测试里的残缺 mock 把侧栏打崩。
 */
export function useEmptyCollaborationSpaces(): EmptyCollaborationSpaces {
  const [spaces, setSpaces] = useState<ProjectWithActivity[]>([]);
  const [revision, setRevision] = useState(0);
  // 可见会话被删/归档/换登录身份后，目录里的 visibleSessionCount 就过期了：
  // 会话 id + 归档态变化时重拉，让最后一条会话消失的空间回到空组。
  const sessions = useSessionStore((state) => state.sessions);
  const sessionsKey = useMemo(
    () => (Array.isArray(sessions) ? sessions.map((s) => `${s.id}:${s.isArchived ? 1 : 0}`).join('|') : ''),
    [sessions],
  );

  const reload = useCallback(async () => {
    try {
      // 残缺 mock 会在读取这个导出时直接抛，不能只判断 typeof。
      if (typeof listProjectsWithActivity !== 'function') {
        setSpaces((current) => (current.length === 0 ? current : []));
        return;
      }
      const rows = await listProjectsWithActivity(false, true);
      setSpaces(Array.isArray(rows) ? rows : []);
    } catch {
      setSpaces((current) => (current.length === 0 ? current : []));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, sessionsKey]);

  useEffect(() => {
    return subscribeProjectSpaceList((change) => {
      setRevision((current) => current + 1);
      void reload();
      if (change !== 'deleted') return;
      const getState = (useSessionStore as {
        getState?: () => { loadSessions?: (options?: { silent?: boolean }) => Promise<void> };
      }).getState;
      if (typeof getState !== 'function') return;
      const loadSessions = getState().loadSessions;
      if (typeof loadSessions === 'function') {
        void loadSessions({ silent: true });
      }
    });
  }, [reload]);

  return { spaces, revision };
}
