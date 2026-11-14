// ============================================================================
// Event reply session (N-TRIGGER-OBSERVE-ACTION-CONTRACT-DESIGN)
// ----------------------------------------------------------------------------
// 通道事件自动化的 host-owned 回复动作（reply_to_event）的会话绑定表：cron 运行
// 起跑时由宿主把本批入站事件的可回复目的地（账号/会话/群名）按会话 id 登记进来，
// 工具执行时只认这张表——模型参数里永远不出现、也不被采纳任何账号/会话 id。
// 与 observeModeGate 同款形态：tools 层的会话键注册表，cron 层登记，执行层消费。
// ============================================================================

import type { CronEventReplyTarget } from '../../shared/contract/cron';
import type { PermissionRequestData } from './types';

/** Host-owned 回复工具名（事件运行专用，普通会话工具表不出现）。 */
export const EVENT_REPLY_TOOL_NAME = 'reply_to_event';

/** 一个已绑定的会话：账号 + 逐事件目的地表。 */
interface EventReplyBinding {
  accountId: string;
  byEventId: ReadonlyMap<string, CronEventReplyTarget>;
  /** 批内去重后的会话目的地（只有一个时 reply_to_event 可省 event_id）。 */
  uniqueChats: readonly CronEventReplyTarget[];
}

const boundSessions = new Map<string, EventReplyBinding>();

/**
 * 为一个事件运行会话登记可回复目的地；返回解除登记函数（运行收尾时调用）。
 * 空目的地（非通道事件 run）不登记，工具在该会话不可用。
 */
export function bindEventReplySession(
  sessionId: string,
  accountId: string,
  targets: readonly CronEventReplyTarget[],
): () => void {
  if (targets.length === 0) return () => {};
  const byEventId = new Map(targets.map((target) => [target.eventId, target]));
  const uniqueChats = [...new Map(targets.map((target) => [target.chatId, target])).values()];
  boundSessions.set(sessionId, { accountId, byEventId, uniqueChats });
  return () => {
    if (boundSessions.get(sessionId)) boundSessions.delete(sessionId);
  };
}

export function isEventReplySession(sessionId: string | undefined): boolean {
  return sessionId !== undefined && boundSessions.has(sessionId);
}

/** 目的地解析结果：ok 携带宿主绑定的账号/会话；否则带稳定错误码（模型可见）。 */
type EventReplyDestination =
  | { ok: true; accountId: string; chatId: string; chatName?: string; replyToMessageId?: string }
  | { ok: false; code: 'EVENT_REPLY_UNBOUND' | 'EVENT_REPLY_UNKNOWN_EVENT' | 'EVENT_REPLY_AMBIGUOUS_CHAT'; message: string };

/**
 * 把一次回复调用解析成宿主绑定的目的地。event_id 给了就必须命中本批事件；没给时
 * 仅当整批事件来自同一个会话才用那个会话，多会话时要求模型点名 event_id。
 * 模型参数里任何账号/会话字段都不参与解析（目的地只出自绑定表）。
 */
export function resolveEventReplyDestination(sessionId: string | undefined, eventId?: string): EventReplyDestination {
  const binding = sessionId === undefined ? undefined : boundSessions.get(sessionId);
  if (!binding) {
    return {
      ok: false,
      code: 'EVENT_REPLY_UNBOUND',
      message: 'reply_to_event is only available inside a channel-event automation run; this session has no inbound event to answer.',
    };
  }
  if (eventId !== undefined) {
    const target = binding.byEventId.get(eventId);
    if (!target) {
      return {
        ok: false,
        code: 'EVENT_REPLY_UNKNOWN_EVENT',
        message: `event_id "${eventId}" is not one of the events carried by this run; use an id= value from the event block.`,
      };
    }
    return { ok: true, accountId: binding.accountId, chatId: target.chatId, ...(target.chatName ? { chatName: target.chatName } : {}), replyToMessageId: target.eventId };
  }
  if (binding.uniqueChats.length !== 1) {
    return {
      ok: false,
      code: 'EVENT_REPLY_AMBIGUOUS_CHAT',
      message: 'this run carries events from more than one chat; pass event_id to say which event you are answering.',
    };
  }
  const only = binding.uniqueChats[0];
  // 单会话批：批内恰好一条事件时直接回复到那条消息；多条事件（同会话）发普通消息，
  // 不猜回复哪条（猜错等于替用户指定错误的上下文）。
  const soleEvent = binding.byEventId.size === 1 ? [...binding.byEventId.values()][0] : undefined;
  return {
    ok: true,
    accountId: binding.accountId,
    chatId: only.chatId,
    ...(only.chatName ? { chatName: only.chatName } : {}),
    ...(soleEvent ? { replyToMessageId: soleEvent.eventId } : {}),
  };
}

/** 决策台账 / 审批卡用的可读目的地：群名优先，取不到群名才回落会话 id。 */
export function eventReplyTargetLabel(sessionId: string | undefined, eventId?: string): string | undefined {
  const destination = resolveEventReplyDestination(sessionId, eventId);
  return destination.ok ? destination.chatName ?? destination.chatId : undefined;
}

/**
 * 审批卡 default 分支的请求构造（对齐 connectorWritePermissionRequest 钩子形态）：
 * 卡上点名「回复到哪个会话」和「会发什么正文」——目的地出自宿主绑定，不采信参数。
 */
export function eventReplyPermissionRequest(
  tool: { name: string; permissionLevel: string },
  params: Record<string, unknown>,
  sessionId: string | undefined,
): PermissionRequestData | undefined {
  if (tool.name !== EVENT_REPLY_TOOL_NAME) return undefined;
  const destination = resolveEventReplyDestination(sessionId, typeof params.event_id === 'string' ? params.event_id : undefined);
  const label = destination.ok ? destination.chatName ?? destination.chatId : 'unknown chat';
  return {
    type: 'network',
    tool: tool.name,
    details: {
      replyText: typeof params.text === 'string' ? params.text : '',
      ...(typeof params.event_id === 'string' ? { eventId: params.event_id } : {}),
      replyDestination: label,
    },
    reason: `Event automation reply: send this message to ${label}.`,
    boundary: {
      id: 'channel.connector',
      reason: `回复会发送到触发本自动化的聊天会话（${label}）。`,
    },
  };
}
