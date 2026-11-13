// Cloud creation guidance and scheduler settings, shared by automation and chat entries.
export const cronCloudZh = {
  cloudCreate: {
    unconfigured: '云端服务尚未配置，这个任务暂时无法在云端运行。',
    switchLocal: '改在这台电脑运行',
    settings: '去配置云端服务',
  },
  cloudSettings: {
    title: '云端计划任务服务',
    description: 'Webhook 触发需要它：Sentry、Linear 等外部系统把事件发到云端链接，Neo 通过这个服务收到并启动任务。',
    baseUrlLabel: '服务地址',
    tokenLabel: '访问令牌',
    tokenPlaceholder: '粘贴云端服务的访问令牌',
    changeToken: '更换',
    save: '保存云端设置',
    saved: '云端服务已保存，已开始接收 Webhook 事件。',
    saveFailed: '保存失败',
    baseUrlRequired: '请先填写服务地址。',
    tokenRequired: '请先填写访问令牌。',
    note: '令牌只保存在本机的安全存储里，不会写进设置文件。',
  },
};

export const cronCloudEn: typeof cronCloudZh = {
  cloudCreate: {
    unconfigured: 'The cloud service is not configured yet, so this task cannot run in the cloud.',
    switchLocal: 'Run on this computer instead',
    settings: 'Go to cloud settings',
  },
  cloudSettings: {
    title: 'Cloud scheduler',
    description: 'Webhook triggers need it: external systems such as Sentry or Linear post events to a cloud link, and Neo receives them here to start your task.',
    baseUrlLabel: 'Service address',
    tokenLabel: 'Access token',
    tokenPlaceholder: 'Paste the cloud service access token',
    changeToken: 'Change',
    save: 'Save cloud settings',
    saved: 'Cloud scheduler saved. Webhook events are now being received.',
    saveFailed: 'Save failed',
    baseUrlRequired: 'Enter the service address first.',
    tokenRequired: 'Enter the access token first.',
    note: 'The token is kept in this device\'s secure storage and is never written to the settings file.',
  },
};
