import { create } from 'zustand';
import { EnvAssistNoticeSchema } from '@shared/contract/envAssistSchema';
import type { EnvAssistNotice } from '@shared/contract/envAssist';

interface EnvAssistState {
  notices: Record<string, EnvAssistNotice>;
  report: (data: unknown) => void;
}

export const useEnvAssistStore = create<EnvAssistState>((set) => ({
  notices: {},
  report: (data) => {
    const parsed = EnvAssistNoticeSchema.safeParse(data);
    if (!parsed.success) return;
    const notice = parsed.data;
    set((state) => ({ notices: { ...state.notices, [notice.id]: notice } }));
  },
}));
