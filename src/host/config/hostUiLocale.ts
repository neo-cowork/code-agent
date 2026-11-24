// ============================================================================
// host 侧用户可见文案的统一语言（ui.language）与显示 surface 读取。
// 语言读取失败回落中文（与既有私有读取器一致），但会 warn 出原因，不静默。
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

export function getHostUiSurface(): 'desktop' | 'cli' {
  return process.env.CODE_AGENT_CLI_MODE === 'true' && process.env.CODE_AGENT_WEB_MODE !== 'true'
    ? 'cli'
    : 'desktop';
}
