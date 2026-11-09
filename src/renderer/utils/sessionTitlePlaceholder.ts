import { isPlaceholderSessionTitle } from '@shared/sessionTitlePlaceholder';
import { languages, type Language } from '../i18n';

/** A non-null result both recognises a placeholder and supplies its UI copy. */
export function getSessionTitlePlaceholder(
  title: string | null | undefined,
  language: Language,
): string | null {
  // Host auto-title eligibility also includes generated prefixes. Preserve named
  // conversations such as "Session planning" rather than reusing them as drafts.
  const named = title?.trim() ?? '';
  if (named.startsWith('Session ') || named.startsWith('CLI Session ')) return null;
  return isPlaceholderSessionTitle(title) ? languages[language].sidebar.newSessionTitle : null;
}
