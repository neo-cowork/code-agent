// Role proactivity requests need the force-confirm write tool in the foreground
// allowlist for this turn. Keep this predicate shared with deferred preloading so
// the tool cannot be loaded and then silently removed by run policy.
const ROLE_PROACTIVITY_INTENT_RE =
  /每天.{0,8}(?:一次|一回)|一天(?:只)?.{0,6}(?:一次|一回)|别(?:再)?.{0,6}(?:报|提|说).{0,6}(?:天气|气象)|少烦我|少打扰我|别(?:再)?主动(?:提醒|打扰|介入)|停止主动(?:提醒|打扰|介入)|主动性|\bproactiv(?:ity|e)\b/i;

export function isRoleProactivityChatIntent(text: string): boolean {
  return ROLE_PROACTIVITY_INTENT_RE.test(text);
}
