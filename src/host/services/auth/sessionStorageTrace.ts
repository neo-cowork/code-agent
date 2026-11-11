// ============================================================================
// Session storage trace — 登录态恢复路径的一次性诊断哨（FB 03 / realrun66）
//
// 背景：冷启动后登录态丢失时，日志只有 `401 missing token` + refresh 失败，
// 无法分辨是 Keychain 条目缺失、token 失效还是存储读失败。本模块集中
// supabase storage adapter 与 secureStorage Keychain 读取路径的降级 warn：
// getSession/removeItem 每进程会走很多次，逐次打 warn 会刷屏，所以每个
// reason 至多告警一次。
//
// 约束：只记录 reason 与非敏感诊断字段——绝不打 token / email / 用户 id /
// 原始 session JSON。
// ============================================================================

import { createLogger } from '../infra/logger';

const logger = createLogger('AuthSessionTrace');

const warnedReasons = new Set<string>();

/**
 * Emit a warn at most once per process for the given reason. Used on hot
 * paths (storage adapter getItem/removeItem, Keychain reads) where the
 * condition itself does not change between calls.
 */
export function warnSessionStorageTrace(
  reason:
    | 'refresh_rejected_session_removed'
    | 'session_storage_empty'
    | 'keychain_module_unavailable'
    | 'keychain_entry_missing',
  message: string,
): void {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  logger.warn(message, { reason });
}
