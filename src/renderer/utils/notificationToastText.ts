/** 应用内提示的一行字：正文已以标题开头（如「需要授权：日历」）时不再把标题重复一遍。 */
export function notificationToastText(title: string, body: string): string {
  return body.startsWith(title) ? body : `${title}: ${body}`;
}
