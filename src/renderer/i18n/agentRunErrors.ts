// /run 被宿主以 400/422 拒绝时的用户文案：宿主只回稳定码（PROMPT_REQUIRED）或裸状态，
// 句子在这里按语言给；原始响应体由调用方 warn 留痕，不进气泡。同 executionEnvironment.ts 先例。

import { PROMPT_REQUIRED } from '@shared/contract/agentRunErrors';
import type { Language } from './index';

const promptRequiredCopy: Record<Language, string> = {
  zh: '请补一句话说明想让我做什么，然后再发送一次。',
  en: 'Add a sentence saying what you want done, then send again.',
};

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
  if (code !== PROMPT_REQUIRED && status !== 400 && status !== 422) return undefined;
  return promptRequiredCopy[language] ?? promptRequiredCopy.zh;
}
