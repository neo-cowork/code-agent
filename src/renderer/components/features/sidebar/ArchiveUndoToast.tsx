import React, { useCallback } from 'react';
import { UI } from '@shared/constants';
import { UndoToast } from '../../primitives';
import { useI18n } from '../../../hooks/useI18n';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSessionArchiveUndoStore, type PendingArchiveUndo } from '../../../stores/sessionArchiveUndoStore';
import { getLocalizedSessionTitle } from '../../../utils/sessionPresentation';

const ArchiveUndoToastItem: React.FC<{ pending: PendingArchiveUndo }> = ({ pending }) => {
  const { t, language } = useI18n();
  const { seq, sessionId, title } = pending;
  // UndoToast 在 onDismiss 引用变化时会重置计时，必须稳定。
  const dismiss = useCallback(() => useSessionArchiveUndoStore.getState().clear(seq), [seq]);
  const undo = useCallback(() => {
    useSessionArchiveUndoStore.getState().clear(seq);
    void useSessionStore.getState().unarchiveSession(sessionId);
  }, [seq, sessionId]);
  return (
    <UndoToast
      message={t.sidebar.archivedToast.replace('{title}', getLocalizedSessionTitle(title, language))}
      onUndo={undo}
      onDismiss={dismiss}
      duration={UI.ARCHIVE_UNDO_TOAST_DURATION}
    />
  );
};

/** 归档后的撤销提示：所有归档入口（行图标/右键菜单/命令面板）都经 store.archiveSession 触发。 */
export const ArchiveUndoToast: React.FC = () => {
  const pending = useSessionArchiveUndoStore((state) => state.pending);
  return pending ? <ArchiveUndoToastItem key={pending.seq} pending={pending} /> : null;
};
