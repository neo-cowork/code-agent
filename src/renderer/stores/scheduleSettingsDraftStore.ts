import { create } from 'zustand';
import type { PendingScheduleDraft } from '../components/features/chat/ChatInput/useScheduleDraft';

/** Only the explicit chat → cloud settings round trip retains a pending draft. */
export const useScheduleSettingsDraftStore = create<{
  draft: PendingScheduleDraft | null;
  stashDraft: (draft: PendingScheduleDraft) => void;
  clearDraft: () => void;
}>((set) => ({
  draft: null,
  stashDraft: (draft) => set({ draft }),
  clearDraft: () => set({ draft: null }),
}));
