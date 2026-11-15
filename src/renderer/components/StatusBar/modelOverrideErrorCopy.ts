// ============================================================================
// modelOverrideErrorCopy - 模型覆盖加载/清除失败 toast 的人话文案 + 原始错误留痕
// ============================================================================
// FB-746：浏览器侧原始错误（"Load failed" / "Failed to fetch"）是工程黑话，
// 不许直接拼进用户 toast。这里把失败原因归成一句可行动的人话。
// 原始 message 永不进 toast，但在 modelOverrideFailureToast 里经 console.error
// 留痕（testing.md「降级路径必须留痕」）——否则 host 返回 session not found、
// IPC 抛错等非网络失败在 renderer 侧零记录，无法判因。

import { zh } from '../../i18n/zh';
import { interpolate } from '../../i18n/interpolate';
import type { ModelSwitcherPanelText } from './modelSwitcherHelpers';

const NETWORK_FAILURE_PATTERN = /load failed|failed to fetch|networkerror|timed? ?out/i;

type OverrideFailureText = Pick<
  ModelSwitcherPanelText,
  'overrideLoadFailed' | 'overrideClearFailed' | 'overrideNetworkReason' | 'overrideRetryReason'
>;

function failureReason(raw: unknown, text: OverrideFailureText): string {
  const message = typeof raw === 'string'
    ? raw
    : raw instanceof Error
      ? raw.message
      : null;
  if (message && NETWORK_FAILURE_PATTERN.test(message)) return text.overrideNetworkReason;
  return text.overrideRetryReason;
}

/**
 * 模型覆盖失败 toast 文案：先 console.error 留下原始错误（仅供排错，永不进 toast），
 * 再归成「加载/清除模型覆盖失败：<人话原因>」。
 */
export function modelOverrideFailureToast(
  action: 'load' | 'clear',
  raw: unknown,
  text: OverrideFailureText = zh.settings.model.models.switcherPanel,
): string {
  console.error(`[ModelSwitcher] ${action === 'load' ? '加载模型覆盖失败' : '清除模型覆盖失败'}（原始错误，未进 toast，仅供排错）:`, raw);
  return interpolate(action === 'load' ? text.overrideLoadFailed : text.overrideClearFailed, { reason: failureReason(raw, text) });
}
