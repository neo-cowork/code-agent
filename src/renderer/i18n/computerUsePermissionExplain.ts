// Computer Use 权限说明文案（语言包；仅中文，原文从 utils/computerUseWorkbench.ts 原样迁入）
export const computerUsePermissionExplainZh = {
  optional: '可选',
  optionalDetail: '默认无需录屏权限。仅当需要截图辅助判断时再单独授权。',
  unknown: '未探测',
  unknownDetail: '当前页还没有拿到 macOS 权限状态，只能展示降级原因，不能判断截图或界面内容的读取是否可靠。',
  unsupported: '当前平台不支持',
  unsupportedDetail: '这个权限只在 macOS 桌面 runtime 下可用。',
  needsRestart: '需要重启',
  needsRestartDetail: (label: string) => `${label} 授权后需要重启 Agent Neo 才能生效。`,
  wrongBundle: 'Bundle 不匹配',
  wrongBundleDetail: (label: string) => `${label} 授权落在了另一个包上，请给当前运行包重新授权。`,
  denied: '未授权',
  unconfirmed: '未确认',
  unconfirmedDetail: (label: string) => `${label} 状态未确认，窗口截图、界面内容或浏览器信息的读取可能失败。`,
} as const;
