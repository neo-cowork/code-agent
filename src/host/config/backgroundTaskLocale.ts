import { createLogger } from '../services/infra/logger';
import type { HostUiLocale } from './hostUiLocale';

const logger = createLogger('BackgroundTaskNaming');
let readLanguage: (() => HostUiLocale) | undefined;

/** Keep config initialization out of the background task persistence module. */
export function bindBackgroundTaskUiLanguage(reader: () => HostUiLocale): void {
  readLanguage = reader;
}

export function getBackgroundTaskUiLanguage(): HostUiLocale {
  try {
    if (readLanguage) return readLanguage();
    logger.warn('UI language unavailable for background task naming; using Chinese fallback');
  } catch (error) {
    logger.warn('Failed to read UI language for background task naming; using Chinese fallback', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return 'zh';
}
