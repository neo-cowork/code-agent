// ============================================================================
// Doctor Check - Provider Health（运行时健康监控状态）
// 复用 providerHealthMonitor 的滚动窗口数据，
// 把 healthy/degraded/recovering/unavailable 映射为 pass/warn/warn/fail。
// ============================================================================

import { DOCTOR_FIX_CODES } from '../../../shared/constants/doctor';
import { getProviderHealthMonitor } from '../../model/providerHealthMonitor';
import type { DoctorItem } from '../types';
import { doctorCopy } from '../i18n/doctorCopy';

export function checkProviderHealth(): DoctorItem[] {
  const monitor = getProviderHealthMonitor();
  const healthMap = monitor.getHealthMap();
  const backendProcess = `backendPid=${process.pid}`;

  if (healthMap.size === 0) {
    return [
      {
        category: 'provider_health',
        name: doctorCopy().names.providerHealthMonitor,
        status: 'skip',
        message: doctorCopy().providerHealth.noRuntimeData,
        details: backendProcess,
      },
    ];
  }

  const items: DoctorItem[] = [];
  for (const [provider, health] of healthMap) {
    let status: DoctorItem['status'];
    let suggestion: string | undefined;
    switch (health.status) {
      case 'healthy':
        status = 'pass';
        break;
      case 'degraded':
        status = 'warn';
        suggestion = doctorCopy().providerHealth.degradedSuggestion;
        break;
      case 'recovering':
        status = 'warn';
        suggestion = doctorCopy().providerHealth.recoveringSuggestion;
        break;
      case 'unavailable':
        status = 'fail';
        suggestion = doctorCopy().providerHealth.unavailableSuggestion;
        break;
      default:
        status = 'warn';
    }

    const errorRatePct = (health.errorRate * 100).toFixed(1);
    items.push({
      category: 'provider_health',
      name: provider,
      status,
      message: `${health.status} · p50 ${health.latencyP50}ms · err ${errorRatePct}%`,
      details: `consecutiveErrors=${health.consecutiveErrors}, p95=${health.latencyP95}ms, ${backendProcess}`,
      suggestion,
      fix: status === 'pass' ? undefined : { code: DOCTOR_FIX_CODES.OPEN_PROVIDER_SETTINGS },
    });
  }

  return items;
}
