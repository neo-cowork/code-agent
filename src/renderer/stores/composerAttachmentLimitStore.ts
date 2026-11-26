// ============================================================================
// Composer Attachment Limit Store - 「附件已满」提示的单槽登记
// ============================================================================
// 全局 toast 是 fixed 悬浮层，会盖住输入框首行和附件卡片。
// 这里改成输入框上方的常驻提示：同一时刻只有一条，新的溢出直接替换旧的。
// ============================================================================

import { create } from 'zustand';

interface AttachmentLimitNotice {
  added: number;
  dropped: number;
  max: number;
  /** 'none'：这次一个都没加进来；'partial'：加进了一部分 */
  kind: 'partial' | 'none';
}

interface AttachmentLimitState {
  notice: AttachmentLimitNotice | null;
  show: (notice: AttachmentLimitNotice) => void;
  clear: () => void;
}

export const useComposerAttachmentLimitStore = create<AttachmentLimitState>()((set) => ({
  notice: null,
  show: (notice) => set({ notice }),
  clear: () => set((s) => (s.notice === null ? s : { notice: null })),
}));
