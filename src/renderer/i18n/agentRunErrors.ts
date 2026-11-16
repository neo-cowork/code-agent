// /run 被宿主以 400/422 拒绝时的用户文案：宿主只回稳定码（PROMPT_REQUIRED）或裸状态，
// 句子在这里按语言给；原始响应体由调用方 warn 留痕，不进气泡。同 executionEnvironment.ts 先例。

import { PROMPT_REQUIRED, REQUEST_INVALID } from '@shared/contract/agentRunErrors';
import type { Language } from './index';
import { sessionConflictLabels } from './projectTrust';

const promptRequiredCopy: Record<Language, string> = {
  zh: '请补一句话说明想让我做什么，然后再发送一次。',
  en: 'Add a sentence saying what you want done, then send again.',
};

// 请求体格式被拒（多为页面过期）：出口是「刷新页面」，zh 与 httpFailureMessage 的 accessDenied 同句。
const requestRejectedCopy: Record<Language, string> = {
  zh: '本地服务没有接受这次请求，请刷新页面后重试。',
  en: 'Neo could not accept this request. Refresh the page and try again.',
};

/** HTTP transport failure copy, keyed by the stable status/code mapping. */
export const httpFailureCopy = {
  genericFailure: {
    zh: 'Neo 暂时没能完成这次请求，请稍后再试。',
    en: 'Neo could not complete the request; please try again in a moment.',
  },
  accessDenied: {
    zh: '本地服务没有接受这次请求，请刷新页面后重试。',
    en: 'The local session could not be verified. Refresh the page and try again.',
  },
  busy: {
    zh: '上一轮还没结束，请稍候再发送。',
    en: 'The previous turn is still finishing. Try again in a moment.',
  },
  // A parked old run needs an explicit action before the next message can be sent.
  sessionHeldByOldRun: {
    zh: `这条消息没发出去：这个会话里还有一个没结束的旧任务。先点「${sessionConflictLabels.zh.abandon}」结束旧任务，再点「${sessionConflictLabels.zh.retry}」。`,
    en: `This message was not sent: an earlier task in this conversation is still open. Click "${sessionConflictLabels.en.abandon}" to end that task first, then "${sessionConflictLabels.en.retry}".`,
  },
  tooManyRequests: {
    zh: '发送太频繁了，请稍等片刻再重试。',
    en: 'Too many requests in a short time. Wait a moment and try again.',
  },
} satisfies Record<string, Record<Language, string>>;

/** PROJECT_SOURCE_TRUST（旧项目 Source 身份快照缺失，需就地确认）：导出供 transport 层映射复用。 */
export const projectSourceTrustCopy: Record<Language, string> = {
  zh: '这个项目文件夹需要你确认后 Neo 才能使用。',
  en: 'This project folder needs your confirmation before Neo can use it.',
};

/**
 * 发送失败是不是「请求被宿主以 400/422 拒绝」（含 PROMPT_REQUIRED）。
 * 是 → 当前语言的下一步提示；不是 → undefined，走原有报错路径。
 * code === PROJECT_SOURCE_TRUST 优先于裸 400/422 规则：同为 422 时先认稳定码。
 */
export function rejectedRequestMessage(error: unknown, language: Language): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, code } = error as { status?: unknown; code?: unknown };
  if (code === 'PROJECT_SOURCE_TRUST') {
    return projectSourceTrustCopy[language] ?? projectSourceTrustCopy.zh;
  }
  if (code === REQUEST_INVALID) {
    return requestRejectedCopy[language] ?? requestRejectedCopy.zh;
  }
  if (code !== PROMPT_REQUIRED && status !== 400 && status !== 422) return undefined;
  return promptRequiredCopy[language] ?? promptRequiredCopy.zh;
}

export const uploadCopy = {
  rateLimitedSeconds: {
    zh: (n: number) => `上传太频繁了，请约 ${n} 秒后再试。`,
    en: (n: number) => `Too many uploads in a short time. Try again in about ${n} seconds.`,
  },
  rateLimited: {
    zh: '上传太频繁了，请稍等片刻再试。',
    en: 'Too many uploads in a short time. Wait a moment and try again.',
  },
  tooLarge: {
    zh: '文件太大，无法上传，请换一个小一点的文件。',
    en: 'This file is too large to upload. Try a smaller file.',
  },
  generic: {
    zh: '没能上传这个文件，请稍后再试。',
    en: 'Could not upload this file. Please try again.',
  },
} as const;
