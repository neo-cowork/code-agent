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
    // Tauri 模式：「重试」只重新检查连接；macOS 壳按 ⌘R 会重启服务并重新载入窗口；退出后重新打开 Neo 是兜底
    unavailableHintTauri: '可点击「重试」，或退出后重新打开 Neo。',
    unavailableHintTauriMac: '可点击「重试」，或按 ⌘R 重新载入；仍不行再退出后重新打开 Neo。',
    // Web 模式：自己刷新页面
    unavailableHintWeb: '也可以刷新页面再试。',
    // /api/run 网络失败时替代裸 `Load failed` 的发送反馈
    sendRetryHint: '正在重新连接后台服务，请稍后再试',
    // 离线期间点击停止：记下意图、断线久/失败/已完成的人话反馈
    stopPending: '连不上后台服务，已记下停止，恢复连接后会马上停下',
    stopUnavailable: '停止还没送到：后台服务暂时连不上',
    stopFailed: '停止没有成功',
    stopRetry: '重试停止',
    stopAlreadyFinished: '这次回复在连接恢复前已经完成，没来得及停下',
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
    unavailableHintTauriMac: "Press Retry, or press ⌘R to reload; if that still doesn't help, quit and reopen Neo.",
    unavailableHintWeb: 'You can also refresh the page to try again.',
    sendRetryHint: 'Reconnecting to the background service — please try again in a moment',
    stopPending: "Can't reach the background service — stop noted and will run as soon as the connection returns",
    stopUnavailable: "Stop hasn't been delivered yet: the background service is temporarily unreachable",
    stopFailed: 'Could not stop this run',
    stopRetry: 'Retry stop',
    stopAlreadyFinished: 'This reply finished before the connection returned, so it could not be stopped in time',
  },
};
