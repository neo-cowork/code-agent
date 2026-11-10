import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { isWindowAway } from '../../../utils/osNotification';

/**
 * 当前会话在窗口离开期间完成会留下未读点（见 useTaskProgressEffects）。
 * 用户回到窗口（聚焦或页面重新可见）即视为已看，只清当前会话的点；其他会话保持未读。
 */
export function useClearCurrentUnreadOnReturn(): void {
  useEffect(() => {
    const clearIfBack = () => {
      if (isWindowAway()) return;
      const { currentSessionId, unreadSessionIds, markSessionRead } = useSessionStore.getState();
      if (currentSessionId && unreadSessionIds.has(currentSessionId)) markSessionRead(currentSessionId);
    };
    window.addEventListener('focus', clearIfBack);
    document.addEventListener('visibilitychange', clearIfBack);
    return () => {
      window.removeEventListener('focus', clearIfBack);
      document.removeEventListener('visibilitychange', clearIfBack);
    };
  }, []);
}
