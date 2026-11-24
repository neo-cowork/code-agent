// ============================================================================
// reply_to_event (N-TRIGGER-OBSERVE-ACTION-CONTRACT-DESIGN)
// ----------------------------------------------------------------------------
// 通道事件自动化的 host-owned 回复动作：目的地（账号/会话）只出自本 run 的会话绑定
// （eventReplySession，宿主按入站事件登记），模型参数只给正文与可选 event_id。
// 观察档：observeModeGate 在审批前把它拦下记一条 would_act（它被归为 EXTERNAL
// 出站工具），本 handler 不会执行。自动档：照常走出站审批（无人值守停车挂起），
// 批准后才真正发送。真实发送复用 ChannelManager.sendMessage（含出站掩码）。
// ============================================================================

import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { CRON_EVENT_TRIGGER } from '../../../../shared/constants';
import { resolveEventReplyDestination } from '../../eventReplySession';
import { replyToEventSchema as schema } from './replyToEvent.schema';

async function executeReplyToEvent(
  args: Record<string, unknown>,
  ctx: ToolContext,
  _canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  if (typeof args.text !== 'string' || args.text.trim().length === 0) {
    return { ok: false, error: 'text must be a non-empty string', code: 'INVALID_ARGS' };
  }
  const destination = resolveEventReplyDestination(ctx.sessionId, typeof args.event_id === 'string' ? args.event_id : undefined);
  if (!destination.ok) {
    return { ok: false, error: destination.message, code: destination.code };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const { getChannelManager } = await import('../../../channels/channelManager');
  const label = destination.chatName ?? destination.chatId;
  try {
    const sent = await getChannelManager().sendMessage(
      destination.accountId,
      destination.chatId,
      args.text.slice(0, CRON_EVENT_TRIGGER.MAX_MESSAGE_CHARS),
      destination.replyToMessageId === undefined ? undefined : { replyToMessageId: destination.replyToMessageId },
    );
    if (!sent.success) {
      // 🔴 返回值必须看：平台拒绝（无效 receive_id / 不在出站白名单）不能静默吞成「成功」。
      return { ok: false, error: `channel rejected the reply to ${label}: ${sent.error ?? 'unknown error'}`, code: 'CHANNEL_SEND_FAILED' };
    }
    ctx.logger.info('reply_to_event sent', { chat: label, replyTo: destination.replyToMessageId ?? null });
    return { ok: true, output: `Replied to ${label}.`, meta: { chatId: destination.chatId, ...(destination.chatName ? { chatName: destination.chatName } : {}) } };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `reply_to_event failed for ${label}: ${failure}`, code: 'CHANNEL_SEND_FAILED' };
  }
}

class ReplyToEventHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeReplyToEvent(args, ctx, canUseTool, onProgress);
  }
}

export const replyToEventModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ReplyToEventHandler();
  },
};
