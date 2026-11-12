/** 云端未配置的可区分错误：IPC 层据此回 CRON_CLOUD_NOT_CONFIGURED，渲染层给本地化引导。 */
import { CRON_CLOUD_NOT_CONFIGURED } from '../../shared/constants/cronErrors';

export class CloudNotConfiguredError extends Error {
  readonly code = CRON_CLOUD_NOT_CONFIGURED;
  constructor(message: string) {
    super(message);
    this.name = 'CloudNotConfiguredError';
  }
}
