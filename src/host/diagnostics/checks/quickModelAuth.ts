// ============================================================================
// Doctor Check - Quick Model Authentication
// 把最近一次快模型鉴权失败暴露给诊断页；成功请求后该记录会自动清除。
// ============================================================================

import { DOCTOR_FIX_CODES } from '../../../shared/constants/doctor';
import { getQuickModelAuthFailure, getQuickModelFailure } from '../../model/quickModel';
import type { DoctorItem } from '../types';
import { doctorCopy } from '../i18n/doctorCopy';

export function checkQuickModelAuth(): DoctorItem[] {
  const copy = doctorCopy();
  const failure = getQuickModelAuthFailure();

  if (failure) {
    return [{
      category: 'provider_health',
      name: copy.names.quickModelHealth,
      status: 'fail',
      message: copy.quickModel.authFailed(failure.provider, failure.model, failure.status),
      suggestion: copy.quickModel.authFailedSuggestion,
      fix: { code: DOCTOR_FIX_CODES.OPEN_PROVIDER_SETTINGS },
    }];
  }

  const modelFailure = getQuickModelFailure();
  if (!modelFailure) {
    return [{
      category: 'provider_health',
      name: copy.names.quickModelHealth,
      status: 'skip',
      message: copy.quickModel.noRecentFailure,
    }];
  }

  const modelLabel = modelFailure.provider && modelFailure.model
    ? copy.quickModel.modelLabel(modelFailure.provider, modelFailure.model)
    : '';
  const statusLabel = modelFailure.status ? copy.quickModel.statusLabel(modelFailure.status) : '';
  const reasonLabel = modelFailure.failureReason === 'invalid_response'
    ? copy.quickModel.invalidResponse
    : copy.quickModel.callFailed(String(modelFailure.failureReason));
  return [{
    category: 'provider_health',
    name: copy.names.quickModelHealth,
    status: 'fail',
    message: copy.quickModel.degraded(modelLabel, reasonLabel, statusLabel),
    suggestion: copy.quickModel.degradedSuggestion,
    fix: { code: DOCTOR_FIX_CODES.OPEN_PROVIDER_SETTINGS },
  }];
}
