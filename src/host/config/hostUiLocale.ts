// ============================================================================
// getHostUiLocale — host 侧用户可见文案的统一语言读取（ui.language）
// 读取失败回落中文（与既有私有读取器一致），但会 warn 出原因，不静默。
// ============================================================================
import { createLogger } from '../services/infra/logger';
import { getConfigService } from '../services/core/configService';

export type HostUiLocale = 'zh' | 'en';

const logger = createLogger('HostUiLocale');

export function getHostUiLocale(): HostUiLocale {
  try {
    return getConfigService().getSettings().ui?.language === 'en' ? 'en' : 'zh';
  } catch (error) {
    logger.warn('ui.language unreadable, falling back to zh', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return 'zh';
  }
}
