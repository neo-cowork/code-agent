// 定时任务因项目文件夹信任失败时的人话（N-FIX-CRON-RUN-ERROR-TRUST-RAW-ENGLISH-PATH）。
// 原因句复用 projectTrust.ts 的 reasons（与聊天里的确认卡同一口径），这里只补下一步。
// 落库的是 PROJECT_SOURCE_TRUST:<kind>[:<folderName>]，绝不显示英文原句或本机路径。

import type { ProjectSourceTrustFailureKind } from '@shared/contract/project';
import { projectTrustTurnCardEn, projectTrustTurnCardZh } from './projectTrust';

const cronTrustFailureCopy = {
  zh: {
    nextStep: '请打开项目设置，重新确认这个文件夹，然后再运行一次。',
    generic: '项目文件夹需要重新确认。',
  },
  en: {
    nextStep: "Open the project's settings, re-confirm the folder, then run again.",
    generic: 'The project folder needs to be re-confirmed.',
  },
} satisfies Record<'zh' | 'en', { nextStep: string; generic: string }>;

/** 原因（带文件夹名，拿不到名字时用「此文件夹」）+ 下一步。没有具体类型时给通用句。 */
export function cronTrustFailureSentence(
  language: 'zh' | 'en',
  trustKind?: ProjectSourceTrustFailureKind,
  folderName?: string,
): string {
  const copy = cronTrustFailureCopy[language];
  const separator = language === 'zh' ? '' : ' ';
  if (!trustKind) return `${copy.generic}${separator}${copy.nextStep}`;
  const card = (language === 'zh' ? projectTrustTurnCardZh : projectTrustTurnCardEn).projectTrustConfirm;
  const reason = card.reasons[trustKind].replace('{name}', folderName ?? card.folder);
  return `${reason}${separator}${copy.nextStep}`;
}
