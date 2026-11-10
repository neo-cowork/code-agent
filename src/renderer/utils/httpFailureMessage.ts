import { languages } from '../i18n';
import { useAppStore } from '../stores/appStore';

/** Response bodies are diagnostics, never user copy (including JSON messages). */
export function getHttpFailureMessage(status: number, code?: string): string {
  const copy = languages[useAppStore.getState().language === 'en' ? 'en' : 'zh'].serverConnection;
  if (code === 'SKILL_FOLDER_TRUST_REQUIRED') return copy.skillFolderTrustRequired;
  if (code === 'PROJECT_SOURCE_TRUST') return copy.folderTrustRequired;
  if (status === 401 || status === 403) return copy.accessDenied;
  if (status === 413) return copy.requestTooLarge;
  if (status === 409 || status === 429) return copy.requestBusy;
  if (status === 400 || status === 422) return copy.invalidRequest;
  return copy.requestFailed;
}

/** Known legacy trust refusal still controls the existing confirmation action. */
export function getHttpFailureCode(errorBody: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(errorBody);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const body = parsed as { code?: unknown; error?: unknown };
    if (typeof body.code === 'string') return body.code;
    if (body.error && typeof body.error === 'object') {
      const error = body.error as { code?: unknown; message?: unknown };
      if (typeof error.code === 'string') return error.code;
      if (typeof error.message === 'string' && error.message.startsWith('该目录未被信任')) {
        return 'SKILL_FOLDER_TRUST_REQUIRED';
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
