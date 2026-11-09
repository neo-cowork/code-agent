import type { PreviewHealthLocale } from '../../../../shared/i18n/previewHealth';
import { getConfigService } from '../../../services/core/configService';

export function readPreviewHealthLocale(): PreviewHealthLocale {
  try {
    return getConfigService().getSettings().ui.language === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}
