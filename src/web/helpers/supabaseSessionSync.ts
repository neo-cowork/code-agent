// ============================================================================
// Supabase 会话行同步（QA 2026-07-28 A5）
// 新会话才写标题（insert-if-absent 首条消息生成的标题，已存在的行不覆盖）；后续轮只更新模型/时间戳，
// 不用当前 prompt 覆盖已有标题——否则侧栏标题会跟随最后一条消息漂移。
// 从 routes/agent.ts 拆出（两处完全相同的调用块），同时控制单文件行数。
// ============================================================================

import type { SupabaseAgentBinding } from '../routes/agentRouteTypes';
import { isPlaceholderSessionTitle } from '../../shared/sessionTitlePlaceholder';

export async function syncSupabaseSessionRow(
  sb: SupabaseAgentBinding,
  args: {
    sessionId: string;
    isNewSession: boolean;
    title: string;
    provider: string;
    model: string;
  },
): Promise<void> {
  if (args.isNewSession) {
    // insert-if-absent：首轮前后各调一次，后一次不得用截断标题顶掉已回写的智能标题
    await sb.supabase.from('sessions').upsert({
      id: args.sessionId,
      user_id: sb.userId,
      title: args.title,
      model_provider: args.provider,
      model_name: args.model,
      created_at: Date.now(),
      updated_at: Date.now(),
      source_device_id: 'web',
    }, { onConflict: 'id', ignoreDuplicates: true });
    // 行已存在（如 POST /sessions 降级路径先建的 'New Session'）时 upsert 被跳过：
    // 仅当云端标题仍是占位才补写首条消息标题；已回写的智能标题 / 手动名不动。
    const { data } = await sb.supabase.from('sessions').select('title').eq('id', args.sessionId);
    if (isPlaceholderSessionTitle((data?.[0] as { title?: string } | undefined)?.title)) {
      await sb.supabase.from('sessions').update({ title: args.title }).eq('id', args.sessionId);
    }
  }
  await sb.supabase.from('sessions').update({
    model_provider: args.provider,
    model_name: args.model,
    updated_at: Date.now(),
    source_device_id: 'web',
  }).eq('id', args.sessionId);
}
