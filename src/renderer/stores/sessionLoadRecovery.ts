import { create } from 'zustand';

/** A failed open is distinct from unrelated session mutations and list refreshes. */
export const useSessionLoadRecoveryStore = create<{
  sessionId: string | null;
  errorCode: string | null;
}>(() => ({ sessionId: null, errorCode: null }));

export function sessionLoadErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : null;
}

export function retrySessionRead(errorCode: string | null, retry: () => Promise<void>): void {
  if (errorCode === 'LOCAL_AUTH_TOKEN_EXPIRED') window.location.reload();
  else void retry();
}
