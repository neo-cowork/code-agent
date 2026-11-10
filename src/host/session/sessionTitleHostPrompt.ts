// 会话自动标题提示词（host 侧）：UI 语言取 ui.language，读不到按中文。
import { getConfigService } from '../services/core/configService';
import { buildSessionTitlePrompt, type SessionTitleLanguage } from '../../shared/sessionTitlePrompt';

function readUiLanguage(): SessionTitleLanguage {
  try {
    return getConfigService().getSettings().ui.language === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function buildHostSessionTitlePrompt(message: string): string {
  return buildSessionTitlePrompt(message, readUiLanguage());
}
