import type { CronNotificationLocale } from '../../shared/i18n/cronNotificationTitle';
import { classifyCronFailure, type CronFailurePresentationKind } from '../../shared/utils/cronFailureClassification';

type FailureSentenceKind = Exclude<CronFailurePresentationKind, 'cloud_unavailable' | 'login_wall'>;

const failureSentences = {
  zh: {
    quota: '模型额度/余额用完了。恢复时间以服务商为准',
    rate_limit: '服务商暂时限流，下次运行会自动再试',
    timeout: '这次运行超时被停了',
    auth: '模型账号没通过授权（密钥错误或已过期）',
    network: '暂时连不上模型服务',
    runtime_starting: 'Neo 刚启动还没准备好，这次运行没能开始。',
    project_trust: '项目文件夹需要重新确认。',
    other: '运行失败',
  },
  en: {
    quota: 'The model quota or balance is used up. The provider decides when it resets.',
    rate_limit: 'The provider is rate-limiting for now. The next run will try again on its own.',
    timeout: 'This run was stopped because it timed out.',
    auth: 'The model account was not authorized (the key is wrong or expired).',
    network: "The model service can't be reached right now.",
    runtime_starting: "Neo was still starting up, so this run couldn't start.",
    project_trust: 'The project folder needs to be re-confirmed.',
    other: 'The run failed.',
  },
} satisfies Record<CronNotificationLocale, Record<FailureSentenceKind, string>>;

export function cronFailureNoticeSentence(
  kind: Exclude<CronFailurePresentationKind, 'cloud_unavailable'>,
  locale: CronNotificationLocale,
): string {
  return failureSentences[locale][kind === 'login_wall' ? 'other' : kind];
}

/**
 * 写回会话的失败短句（角色线程收据、源会话的 automation 回流消息；这些消息整条是中文，不随界面语言）。
 * 项目文件夹信任失败只写文件夹名的人话：落库的 execution.error 是内部标记
 * PROJECT_SOURCE_TRUST:<kind>:<文件夹名>（存量是英文原句 + 本机绝对路径），不能原样给用户看。
 * 其它失败返回 undefined，由调用方写各自的原文。
 */
export function cronProjectTrustFailureText(storedError: string | undefined): string | undefined {
  const classified = classifyCronFailure(storedError ?? '');
  if (classified.kind !== 'project_trust') return undefined;
  return classified.folderName ? `项目文件夹“${classified.folderName}”需要重新确认` : '项目文件夹需要重新确认';
}
