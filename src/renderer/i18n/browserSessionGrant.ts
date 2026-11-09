export const browserSessionGrantZh = {
  question: '允许 Neo 在 {site}{action}吗？',
  unknownSite: '当前页面',
  actions: { open: '打开网页', handle_dialog: '处理网页对话框', read_clipboard: '读取剪贴板', write_clipboard: '写入剪贴板', wait_for_download: '等待下载' } as Record<string, string>,
  crossSite: '这次对话中，你之前只允许在 {previous} 进行这类操作。当前是 {site}，需要你另行允许。',
  unresolved: '无法确认当前网站。这次允许仅对当前操作生效，下次仍会询问。',
  session: '本次对话允许',
  sessionDesc: '仅允许在这个网站进行同类操作；其他网站仍会询问。',
};
export const browserSessionGrantEn: typeof browserSessionGrantZh = {
  question: 'Allow Neo to {action} on {site}?',
  unknownSite: 'the current page',
  actions: { open: 'open the page', handle_dialog: 'handle a page dialog', read_clipboard: 'read the clipboard', write_clipboard: 'write to the clipboard', wait_for_download: 'wait for a download' },
  crossSite: 'Earlier in this conversation, you allowed this kind of action only on {previous}. This is {site}, so it needs your approval separately.',
  unresolved: 'The current site could not be confirmed. Allowing applies to this action only; Neo will ask again next time.',
  session: 'Allow for this session',
  sessionDesc: 'Allow this kind of action on this site only; other sites still ask.',
};
