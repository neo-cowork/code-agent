// ============================================================================
// Doctor Check - App 版本
// 查询 updateService 的 checkForUpdates：
//   - hasUpdate=false  → pass
//   - hasUpdate=true   → warn（提示有新版可更新；fail 太重）
//   - 网络/服务未初始化 → warn / skip（不应阻塞 doctor）
// ============================================================================

import {
  getUpdateService,
  isUpdateServiceInitialized,
} from '../../services/cloud/updateService';
import { DOCTOR_FIX_CODES } from '../../../shared/constants/doctor';
import type { DoctorItem } from '../types';
import { doctorCopy } from '../i18n/doctorCopy';

export async function checkAppVersion(): Promise<DoctorItem> {
  if (!isUpdateServiceInitialized()) {
    return {
      category: 'version',
      name: doctorCopy().names.appVersion,
      status: 'skip',
      message: doctorCopy().version.updateServiceMissing,
    };
  }

  const svc = getUpdateService();
  const currentVersion = svc.getCurrentVersion();

  try {
    const info = await svc.checkForUpdates();
    if (info.hasUpdate) {
      return {
        category: 'version',
        name: doctorCopy().names.appVersion,
        status: 'warn',
        message: doctorCopy().version.updateAvailable(currentVersion, info.latestVersion ?? '?'),
        suggestion: doctorCopy().version.updateSuggestion,
        details: info.releaseNotes,
        fix: { code: DOCTOR_FIX_CODES.OPEN_UPDATE_SETTINGS },
      };
    }
    return {
      category: 'version',
      name: doctorCopy().names.appVersion,
      status: 'pass',
      message: doctorCopy().version.upToDate(currentVersion),
    };
  } catch (err) {
    return {
      category: 'version',
      name: doctorCopy().names.appVersion,
      status: 'warn',
      message: doctorCopy().version.checkFailed(err instanceof Error ? err.message : String(err)),
      suggestion: doctorCopy().version.checkFailedSuggestion(currentVersion),
      fix: { code: DOCTOR_FIX_CODES.OPEN_PROXY_HELP },
    };
  }
}
