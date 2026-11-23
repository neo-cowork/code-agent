import type { CronNotificationLocale } from '../../shared/i18n/cronNotificationTitle';
import type { CronFailurePresentationKind } from '../../shared/utils/cronFailureClassification';

type FailureSentenceKind = Exclude<CronFailurePresentationKind, 'cloud_unavailable' | 'login_wall'>;

const failureSentences = {
  zh: {
    quota: '模型额度/余额用完了。恢复时间以服务商为准',
    rate_limit: '服务商暂时限流，下次运行会自动再试',
    timeout: '这次运行超时被停了',
    auth: '模型账号没通过授权（密钥错误或已过期）',
    network: '暂时连不上模型服务',
    runtime_starting: 'Neo 刚启动还没准备好，这次运行没能开始。',
    other: '运行失败',
  },
  en: {
    quota: 'The model quota or balance is used up. The provider decides when it resets.',
    rate_limit: 'The provider is rate-limiting for now. The next run will try again on its own.',
    timeout: 'This run was stopped because it timed out.',
    auth: 'The model account was not authorized (the key is wrong or expired).',
    network: "The model service can't be reached right now.",
    runtime_starting: "Neo was still starting up, so this run couldn't start.",
    other: 'The run failed.',
  },
} satisfies Record<CronNotificationLocale, Record<FailureSentenceKind, string>>;

export function cronFailureNoticeSentence(
  kind: Exclude<CronFailurePresentationKind, 'cloud_unavailable'>,
  locale: CronNotificationLocale,
): string {
  return failureSentences[locale][kind === 'login_wall' ? 'other' : kind];
}
