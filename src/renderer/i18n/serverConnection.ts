// ============================================================================
// serverConnection 域词条（ServerConnectionBanner + /api/run 网络失败人话）
// —— N-WEBSERVER-DEATH-SUPERVISE-BANNER，zh/en 同文件相邻维护。
// ============================================================================

export const serverConnectionZh = {
  serverConnection: {
    // recovering：服务死亡、壳在自动重启期间；「无需操作」是关键承诺
    recovering: '正在重新连接 Neo 的后台服务…通常几秒内自动恢复，无需操作',
    // unavailable：壳的重试也失败（用户在系统弹窗选了「稍后」）之后
    unavailable: 'Neo 的后台服务暂时无法恢复',
    retry: '重试',
    // Tauri 模式：恢复动作指向系统弹窗的「重试」/重开应用（页面此时未必能自愈）
    unavailableHintTauri: '可在系统弹窗中选择「重试」，或重新打开应用。',
    // Web 模式：自己刷新页面
    unavailableHintWeb: '也可以刷新页面再试。',
    // /api/run 网络失败时替代裸 `Load failed` 的发送反馈
    sendRetryHint: '正在重新连接后台服务，请稍后再试',
    requestFailed: 'Neo 暂时无法完成请求，请稍后重试。',
    invalidRequest: '这次请求无法处理，请调整内容后重试。',
    accessDenied: '这次操作未获授权，请检查访问权限后重试。',
    requestTooLarge: '发送的内容太大，请减少附件或内容后重试。',
    requestBusy: 'Neo 暂时无法接收请求，请稍后重试。',
    skillFolderTrustRequired: '该文件夹需要信任确认，请在此文件夹中打开会话并确认信任后重试。',
    folderIdentityConfirmation: '此文件夹需要重新确认，请确认信任后继续发送。',
    confirmFolderIdentity: '确认信任并发送',
    dismissFolderIdentity: '暂不确认',
    folderTrustRequired: '项目文件夹需要重新确认，请在项目设置中检查并信任该文件夹后重试。',
  },
};

export const serverConnectionEn = {
  serverConnection: {
    recovering: "Reconnecting to Neo's background service… this usually recovers by itself in a few seconds",
    unavailable: "Neo's background service could not be restored",
    retry: 'Retry',
    unavailableHintTauri: 'Use Retry in the system dialog, or reopen the app.',
    unavailableHintWeb: 'You can also refresh the page to try again.',
    sendRetryHint: 'Reconnecting to the background service — please try again in a moment',
    requestFailed: 'Neo could not complete the request; please try again in a moment.',
    invalidRequest: 'This request could not be processed; please adjust the content and try again.',
    accessDenied: 'This action was not authorized; please check your access and try again.',
    requestTooLarge: 'The content is too large; please reduce the attachments or text and try again.',
    requestBusy: 'Neo cannot accept the request right now; please try again in a moment.',
    skillFolderTrustRequired: 'This folder needs trust confirmation; please open a conversation in the folder and confirm trust, then try again.',
    folderIdentityConfirmation: 'This folder needs to be confirmed again; confirm trust to send your message.',
    confirmFolderIdentity: 'Confirm trust and send',
    dismissFolderIdentity: 'Not now',
    folderTrustRequired: 'The project folder needs confirmation; please review and trust it in project settings, then try again.',
  },
};
