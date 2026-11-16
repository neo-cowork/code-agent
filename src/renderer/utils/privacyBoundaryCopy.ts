import {
  getPrivacyBoundaryActionShortLabel,
  type PrivacyBoundaryIndexEntry,
} from '@shared/contract/privacyBoundaryIndex';
import type { AuthInventoryItem } from '@shared/contract/authInventory';
import type { VoiceTranscriptionPath } from '@shared/contract/voiceTranscription';
import type { Language } from '../i18n';
import { privacyBoundaryIndexEn, type PrivacyBoundaryEntryCopy } from '../i18n/privacyBoundaryIndexEn';
import {
  authInventoryEn,
  voiceTranscriptionPathsEn,
  type AuthInventoryItemCopy,
  type VoiceTranscriptionPathCopy,
} from '../i18n/privacyVoiceAuthEn';

/**
 * 隐私边界条目显示文案的唯一出口：中文界面直接用索引里的原文，
 * 英文界面按条目 id 取 privacyBoundaryIndexEn。
 */
export function getPrivacyBoundaryEntryCopy(
  entry: PrivacyBoundaryIndexEntry,
  language: Language,
): PrivacyBoundaryEntryCopy {
  if (language === 'en') return privacyBoundaryIndexEn[entry.id];
  return {
    title: entry.title,
    summary: entry.summary,
    data: entry.data,
    storage: entry.storage,
    cloud: entry.cloud,
    revoke: entry.revoke,
    actionShortLabel: getPrivacyBoundaryActionShortLabel(entry),
  };
}

/** 语音转写路径卡片的显示文案：中文用契约原文，英文按路径 id 取 voiceTranscriptionPathsEn。 */
export function getVoiceTranscriptionPathCopy(
  path: VoiceTranscriptionPath,
  language: Language,
): VoiceTranscriptionPathCopy {
  if (language === 'en') return voiceTranscriptionPathsEn[path.id];
  return {
    title: path.title,
    trigger: path.trigger,
    providers: path.providers,
    cloud: path.cloud,
    temporaryStorage: path.temporaryStorage,
    logPolicy: path.logPolicy,
  };
}

/** 凭证清单卡片的显示文案：中文用契约原文，英文按条目 id 取 authInventoryEn。 */
export function getAuthInventoryItemCopy(item: AuthInventoryItem, language: Language): AuthInventoryItemCopy {
  const english = language === 'en' ? authInventoryEn.get(item.id) : undefined;
  if (english) return english;
  return {
    title: item.title,
    examples: item.examples,
    storage: item.storage,
    display: item.display,
    diagnosticPolicy: item.diagnosticPolicy,
  };
}
