// ============================================================================
// 会话标题回写云端 sessions 行（N-FIX-SESSION-TITLE-REVERTS-TO-RAW-MESSAGE-FU1）
// 智能标题 / 手动改名 / 手机改名都经 SessionManager.updateSession 的标题分支落到这里。
// 只更新已存在云端行的 title + updated_at；不上传任何消息正文，不改 synced_at。
// fail-open：任何失败只 warn（带可区分原因），不抛、不阻塞本地改名。
// ============================================================================

import { getAuthService } from '../auth/authService';
import { getSupabase, isSupabaseInitialized } from './supabaseService';
import { createLogger } from './logger';

const logger = createLogger('SessionTitleCloudPush');

async function push(sessionId: string, title: string): Promise<void> {
  if (!isSupabaseInitialized()) {
    logger.warn('Session title cloud push skipped: supabase not initialized', { sessionId });
    return;
  }
  const user = getAuthService().getCurrentUser();
  if (!user?.id) {
    logger.warn('Session title cloud push skipped: no signed-in user', { sessionId });
    return;
  }
  const { data, error } = await getSupabase()
    .from('sessions')
    .update({ title, updated_at: Date.now() })
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .select('id');
  if (error) {
    logger.warn('Session title cloud push failed: request error', { sessionId, error });
    return;
  }
  if (!Array.isArray(data) || data.length === 0) {
    logger.warn('Session title cloud push skipped: cloud row absent', { sessionId });
    return;
  }
  logger.info('Session title pushed to cloud row', { sessionId, title });
}

/** fire-and-forget：永不抛出。 */
export function pushSessionTitleToCloud(sessionId: string, title: string): void {
  if (!title.trim()) return;
  void push(sessionId, title).catch((error) => {
    logger.warn('Session title cloud push failed: unexpected error', { sessionId, error });
  });
}
