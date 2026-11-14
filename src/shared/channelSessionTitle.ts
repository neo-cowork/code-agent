const CHANNEL_TITLE = /^(\[Channel\]\s*)(.*)$/i;
const CHAT_ID_SUFFIX = /\s*·\s*(?:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|(?:oc|ou|chat|ch)_[\w-]+|(?=[a-z\d_-]*\d)[a-z\d_-]{24,}|\d{8,})$/i;

/** `[Channel] account · <chat id>`: the trailing chat id is routing data, never part of the visible name. */
export function splitChannelSessionTitle(title: string): { prefix: string; name: string } | null {
  const match = CHANNEL_TITLE.exec(title);
  return match ? { prefix: match[1], name: match[2].replace(CHAT_ID_SUFFIX, '').trim() } : null;
}
