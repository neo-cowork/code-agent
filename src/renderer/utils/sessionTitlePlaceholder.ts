import { isPlaceholderSessionTitle } from '@shared/sessionTitlePlaceholder';
import { languages, type Language } from '../i18n';

/** A non-null result both recognises a placeholder and supplies its UI copy. */
export function getSessionTitlePlaceholder(
  title: string | null | undefined,
  language: Language,
): string | null {
  return isPlaceholderSessionTitle(title) ? languages[language].sidebar.newSessionTitle : null;
}
