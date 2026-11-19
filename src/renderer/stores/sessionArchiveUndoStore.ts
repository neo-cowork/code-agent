// 归档后「撤销」Toast 的待展示状态。archiveSession 成功后写入，ArchiveUndoToast 读取；
// 连续归档第二条会替换前一条（seq 递增，组件按 seq 重挂载以重置计时）。
import { create } from 'zustand';

export interface PendingArchiveUndo {
  sessionId: string;
  title: string;
  /** 归档前的 updatedAt：撤销时传给 host，让会话回到原排序位置 */
  updatedAt?: number;
  seq: number;
}

interface SessionArchiveUndoState {
  pending: PendingArchiveUndo | null;
  show: (sessionId: string, session?: { title?: string; updatedAt?: number }) => void;
  clear: (seq?: number) => void;
}

let nextSeq = 0;

export const useSessionArchiveUndoStore = create<SessionArchiveUndoState>((set, get) => ({
  pending: null,
  show: (sessionId, session) =>
    set({ pending: { sessionId, title: session?.title ?? '', updatedAt: session?.updatedAt, seq: ++nextSeq } }),
  // 带 seq 时只清自己那一条，避免旧 Toast 的延迟回调误清新 Toast。
  clear: (seq) => {
    const { pending } = get();
    if (pending && (seq === undefined || pending.seq === seq)) set({ pending: null });
  },
}));
