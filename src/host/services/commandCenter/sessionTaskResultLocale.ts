import type { SessionTaskResultStatusWordLocale } from '../../../shared/constants/sessionCommandCenter';
import { getConfigService } from '../core/configService';

export function resolveSessionTaskResultLocale(): SessionTaskResultStatusWordLocale {
  try {
    return getConfigService().getSettings().ui.language;
  } catch {
    return 'zh';
  }
}
