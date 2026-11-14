// ============================================================================
// connectorRequired 域词条（聊天内「连接器未连接」连接卡，N-CONNECTOR-POLISH-AUDIT-FU1）
// —— zh/en 同文件相邻维护。continuation 是连接完成后自动追加的那条用户消息。
// ============================================================================

export const connectorRequiredZh = {
  connectorRequired: {
    title: '{name} 还没连接',
    body: '连接后会自动继续刚才的任务',
    connect: '去连接',
    later: '稍后',
    resuming: '{name} 已连接，正在继续',
    manual: '我已连好，继续',
    continuation: '{name} 已连接，请继续刚才的任务',
    scopeTitle: '{name} 当前的授权缺少这次操作需要的权限',
    scopeBody: '重新授权并同意缺少的权限后，再重发刚才的请求',
    scopeScope: '缺少的权限：{scope}',
    reauthorize: '重新授权',
    reauthorizing: '正在等待授权完成…',
    reauthorized: '{name} 已重新授权，请重新发送刚才的请求',
    reauthorizeFailed: '重新授权没有完成：{error}',
    permissionPage: '查看权限设置',
    dismiss: '知道了',
    lostTitle: '{name} 当前未登录，请重新连接后继续',
    lostReasonNotLoggedIn: '它的命令行工具当前没有报告已登录。',
    lostReasonMissingConfig: '它的命令行工具报告配置缺失或尚未登录。',
    lostReasonAuthorization: '它的服务端要求重新授权。',
    reconnect: '重新连接',
    reconnecting: '正在连接…',
    reconnected: '{name} 已重新连接，请重新发送刚才的请求',
    reconnectFailed: '重新连接没有完成，请稍后再试',
  },
};

export const connectorRequiredEn: typeof connectorRequiredZh = {
  connectorRequired: {
    title: '{name} is not connected yet',
    body: 'Once connected, the task continues automatically',
    connect: 'Connect',
    later: 'Later',
    resuming: '{name} is connected, continuing',
    manual: "I've connected it, continue",
    continuation: '{name} is connected, please continue the previous task',
    scopeTitle: "{name}'s current authorization lacks the permission this action needs",
    scopeBody: 'Reauthorize and approve the missing permission, then resend your request',
    scopeScope: 'Missing permission: {scope}',
    reauthorize: 'Reauthorize',
    reauthorizing: 'Waiting for authorization to finish…',
    reauthorized: '{name} is reauthorized, please resend your request',
    reauthorizeFailed: 'Reauthorization did not complete: {error}',
    permissionPage: 'Open permission settings',
    dismiss: 'Got it',
    lostTitle: '{name} is not signed in. Reconnect to continue.',
    lostReasonNotLoggedIn: 'Its command-line tool does not currently report a signed-in account.',
    lostReasonMissingConfig: 'Its command-line tool reports missing configuration or no sign-in.',
    lostReasonAuthorization: 'Its server requires authorization again.',
    reconnect: 'Reconnect',
    reconnecting: 'Connecting…',
    reconnected: '{name} is reconnected, please resend your request',
    reconnectFailed: 'Reconnecting did not complete, please try again later',
  },
};
