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
    checking: '正在检查…',
    retryFailed: '仍未恢复',
    // Tauri 模式：重试只检查连接；退出后重新打开 Neo 才会重新启动服务
    unavailableHintTauri: '可点击「重试」，或退出后重新打开 Neo。',
    // Web 模式：自己刷新页面
    unavailableHintWeb: '也可以刷新页面再试。',
    // /api/run 网络失败时替代裸 `Load failed` 的发送反馈
    sendRetryHint: '正在重新连接后台服务，请稍后再试',
  },
};

export const serverConnectionEn = {
  serverConnection: {
    recovering: "Reconnecting to Neo's background service… this usually recovers by itself in a few seconds",
    unavailable: "Neo's background service could not be restored",
    retry: 'Retry',
    checking: 'Checking…',
    retryFailed: 'Still not recovered',
    unavailableHintTauri: 'Press Retry, or quit and reopen Neo.',
    unavailableHintWeb: 'You can also refresh the page to try again.',
    sendRetryHint: 'Reconnecting to the background service — please try again in a moment',
  },
};
