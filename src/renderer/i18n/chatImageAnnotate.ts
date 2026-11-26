// ============================================================================
// 聊天图片批注（在图上框出区域并发给助手）文案 —— zh/en 同文件相邻维护。
// 方位词 / 消息文本模板 / 弹窗文案都走这里，组件与工具函数里不写裸文案。
// ============================================================================

export const chatImageAnnotateZh = {
  chatImageAnnotate: {
    actionLabel: '批注',
    actionTitle: '在图上框出要改的地方，发给助手',
    modalTitle: '在图上框出要改的地方',
    hint: '在图片上按住鼠标拖出一个框，再在右侧写下这个框要怎么改。',
    regionLabel: '区域 {n}',
    commentPlaceholder: '这里要怎么改？',
    removeRegion: '删除这个框',
    noteLabel: '整体说明（可选）',
    notePlaceholder: '比如：整体配色再柔和一点',
    send: '发给助手',
    cancel: '取消',
    needRegion: '先在图片上拖出至少一个框。',
    loadFailed: '这张图读取不出来，暂时没法批注。',
    sendFailed: '没能生成带框的图片，请重试。',
    finishEditFirst: '输入框正在编辑一条排队消息，请先发送或取消那条编辑，再发批注。',
    loading: '正在读取图片…',
    positionGrid: [
      ['左上', '上方', '右上'],
      ['左侧', '中间', '右侧'],
      ['左下', '下方', '右下'],
    ],
    positionWhole: '整张图',
    positionWideBand: '横跨整行',
    positionTallBand: '贯穿整列',
    messageHeader: { one: '我在图片上框出了 {count} 处，请按框和说明修改：', other: '我在图片上框出了 {count} 处，请按框和说明修改：' },
    regionLine: '区域 {n}（{position}，约 横向 {x1}–{x2}%，纵向 {y1}–{y2}%）：{comment}',
    noComment: '（没写说明）',
    noteLine: '整体说明：{note}',
    captureName: '图片批注',
  },
};

export const chatImageAnnotateEn: typeof chatImageAnnotateZh = {
  chatImageAnnotate: {
    actionLabel: 'Mark up',
    actionTitle: 'Box the spots to change and send them to the assistant',
    modalTitle: 'Box the spots you want changed',
    hint: 'Drag on the image to draw a box, then write what to change for that box on the right.',
    regionLabel: 'Region {n}',
    commentPlaceholder: 'What should change here?',
    removeRegion: 'Remove this box',
    noteLabel: 'Overall note (optional)',
    notePlaceholder: 'For example: make the colors softer overall',
    send: 'Send to assistant',
    cancel: 'Cancel',
    needRegion: 'Draw at least one box on the image first.',
    loadFailed: 'This image could not be read, so it cannot be marked up right now.',
    sendFailed: 'Could not create the image with boxes. Please try again.',
    finishEditFirst: 'The composer is editing a queued message. Send or cancel that edit first, then send the markup.',
    loading: 'Loading image…',
    positionGrid: [
      ['top-left', 'top', 'top-right'],
      ['left', 'center', 'right'],
      ['bottom-left', 'bottom', 'bottom-right'],
    ],
    positionWhole: 'the whole image',
    positionWideBand: 'across the full width',
    positionTallBand: 'down the full height',
    messageHeader: { one: 'I boxed {count} spot on the image. Please change it as described:', other: 'I boxed {count} spots on the image. Please change them as described:' },
    regionLine: 'Region {n} ({position}, about x {x1}–{x2}%, y {y1}–{y2}%): {comment}',
    noComment: '(no note)',
    noteLine: 'Overall note: {note}',
    captureName: 'Image markup',
  },
};
