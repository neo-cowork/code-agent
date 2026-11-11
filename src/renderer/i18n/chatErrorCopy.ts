import { toolErrorCodesEn, toolErrorCodesZh } from './toolErrorCodes';

export const chatErrorCopyZh = {
systemError: {
  fallbackSummary: '执行时出了问题',
  fallbackDetail: '可以重试一次，或换个说法再试试。',
  viewDetails: '查看详情',
  hideDetails: '收起',
},

// 工具报错人话化（toolExecutionPresentation.ts 的 humanizeToolError，7 类）——
// 判别顺序有意为之，额度/余额排最前，避免上游把额度错误裹成 401 被误判成鉴权。
toolErrors: {
  quota: {
    summary: '额度/余额不足：当前服务的用量或余额已耗尽',
    detail: '请充值，或在设置里换一个还有额度的 key。',
    sourcesSummary: '联网搜索额度不足：{sources} 的 API 套餐用量已耗尽',
    sourcesDetail: '要恢复这些源请充值，或换一个还有额度的 key。',
  },
  rateLimit: {
    summary: '请求过于频繁，被限流',
    detail: '稍等片刻会自动重试；如持续可降低并发或稍后再试。',
  },
  auth: {
    summary: '鉴权失败：API Key 无效或无权限',
    detail: '去「设置 > Service API Keys」检查对应服务的 Key。',
  },
  overloaded: {
    summary: '服务过载或暂时不可用',
    detail: '稍后会自动重试。',
  },
  timeout: {
    summary: '请求超时',
    detail: '稍后重试，或检查网络 / 代理。',
  },
  network: {
    summary: '网络异常，连接失败',
    detail: '检查网络或代理后重试。',
  },
  autoLoaded: {
    summary: '工具已自动加载，正在用正确参数重试',
  },
  artifactValidation: {
    detail: '文件变更已落盘，但验收没有通过。',
  },
  // 未登记 code / 没有 metadata 的错误仍走正则兜底；分不出类别的由调用方展示原始报错。
  codes: toolErrorCodesZh,
},

};

export const chatErrorCopyEn = {
systemError: {
  fallbackSummary: 'Something went wrong while running this',
  fallbackDetail: 'Try again, or rephrase your request.',
  viewDetails: 'View details',
  hideDetails: 'Hide',
},

// Tool error humanization (toolExecutionPresentation.ts's humanizeToolError, 7 kinds) —
// order is intentional: quota/balance is checked first since upstream often wraps quota
// errors as HTTP 401, which would otherwise be misread as an auth failure.
toolErrors: {
  quota: {
    summary: 'Quota or balance exhausted for this service',
    detail: 'Top up, or switch to a key with remaining quota in settings.',
    sourcesSummary: 'Search quota exhausted: usage for {sources} is used up',
    sourcesDetail: 'Top up these sources, or switch to a key with remaining quota.',
  },
  rateLimit: {
    summary: 'Rate limited: too many requests',
    detail: 'This will retry automatically shortly; lower concurrency or try again later if it persists.',
  },
  auth: {
    summary: 'Authentication failed: invalid API key or no permission',
    detail: 'Check the key for this service under Settings > Service API Keys.',
  },
  overloaded: {
    summary: 'Service overloaded or temporarily unavailable',
    detail: 'This will retry automatically shortly.',
  },
  timeout: {
    summary: 'Request timed out',
    detail: 'Retry later, or check your network / proxy.',
  },
  network: {
    summary: 'Network error: connection failed',
    detail: 'Check your network or proxy, then retry.',
  },
  autoLoaded: {
    summary: 'Tool was auto-loaded and is retrying with the correct arguments',
  },
  artifactValidation: {
    detail: 'The file change was written, but validation did not pass.',
  },
  // Unregistered codes and missing metadata still fall through to the regex path.
  codes: toolErrorCodesEn,
},

};
