/**
 * Classifies CLI connector execution errors (lark-cli / tmeet) that indicate a
 * missing or expired user sign-in, distinct from missing scopes or transient errors.
 */
const FEISHU_NOT_LOGGED_IN_PATTERN = /not_configured|profile\s+\S+\s+not found|not configured|no logged-in user|not logged in|login required|token expired|invalid access token|user_access_token|99991663|99991668|please login/iu;
const FEISHU_SCOPE_PATTERN = /insufficient[ _-]scope|99991679/iu;
const TMEET_NOT_LOGGED_IN_PATTERN = /user config is empty|not logged in|login required|token expired|unauthorized/iu;

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return typeof error === 'string' ? error : '';
  const record = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [record.message, record.stdout, record.stderr]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n');
}

export function isCliNotLoggedInError(connectorId: 'feishu' | 'tmeet', error: unknown): boolean {
  const combined = errorText(error);
  if (!combined) return false;
  if (connectorId === 'feishu') {
    if (FEISHU_SCOPE_PATTERN.test(combined)) return false;
    return FEISHU_NOT_LOGGED_IN_PATTERN.test(combined);
  }
  return TMEET_NOT_LOGGED_IN_PATTERN.test(combined);
}
