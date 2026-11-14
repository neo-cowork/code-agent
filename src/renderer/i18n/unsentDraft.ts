// 未发送输入框草稿恢复条（文本 + 附件 + 超上限未保存文件名）词条。独立文件避免 chatInput.ts 触碰 max-lines。

export const unsentDraftCopyZh = {
  unsentDraftNotice: '上次输入框里还有一段内容：「{preview}」',
  unsentDraftNoticeWithOneAttachment: '上次输入框里还有一段内容：「{preview}」，另有 1 个附件：{names}',
  unsentDraftNoticeWithAttachments: '上次输入框里还有一段内容：「{preview}」，另有 {count} 个附件：{names}',
  unsentDraftOneAttachmentOnly: '上次输入框里还有 1 个未发送附件：{names}',
  unsentDraftAttachmentsOnly: '上次输入框里还有 {count} 个未发送附件：{names}',
  unsentDraftOneDroppedOnly: '上次添加的附件超出容量，未保存：{dropped}',
  unsentDraftDroppedOnly: '上次添加的附件超出容量，未保存：{dropped}',
  unsentDraftDroppedSuffix: '（超出容量未保存：{dropped}）',
  unsentDraftNameSeparator: '、',
  unsentDraftPutBack: '放回输入框',
  unsentDraftDiscard: '丢弃',
};

export const unsentDraftCopyEn: typeof unsentDraftCopyZh = {
  unsentDraftNotice: 'There is still text from the input box: "{preview}"',
  unsentDraftNoticeWithOneAttachment: 'There is still text from the input box: "{preview}", plus 1 attachment: {names}',
  unsentDraftNoticeWithAttachments: 'There is still text from the input box: "{preview}", plus {count} attachments: {names}',
  unsentDraftOneAttachmentOnly: 'There is still 1 unsent attachment: {names}',
  unsentDraftAttachmentsOnly: 'There are still {count} unsent attachments: {names}',
  unsentDraftOneDroppedOnly: 'Attachment exceeded the limit and was not saved: {dropped}',
  unsentDraftDroppedOnly: 'Attachments exceeded the limit and were not saved: {dropped}',
  unsentDraftDroppedSuffix: ' (exceeded limit, not saved: {dropped})',
  unsentDraftNameSeparator: ', ',
  unsentDraftPutBack: 'Put it back in the input',
  unsentDraftDiscard: 'Discard',
};
