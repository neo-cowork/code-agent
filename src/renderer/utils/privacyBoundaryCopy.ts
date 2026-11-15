import {
  getPrivacyBoundaryActionShortLabel,
  type PrivacyBoundaryIndexEntry,
} from '@shared/contract/privacyBoundaryIndex';
import type { Language } from '../i18n';
import { privacyBoundaryIndexEn, type PrivacyBoundaryEntryCopy } from '../i18n/privacyBoundaryIndexEn';

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
