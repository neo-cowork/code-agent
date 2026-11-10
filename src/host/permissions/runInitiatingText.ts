// ============================================================================
// runInitiatingText —— 一轮 run 的「发起话」定值（N-PERM-NL-RULES-K2）
// ----------------------------------------------------------------------------
// preapprove（我说了才做）的触发短语只能在**用户自己写的话**里匹配。发给模型的那份
// 请求不是：它前面拼着角色资料块、通话告知、能力告知、渠道指令，后面可能跟着上轮
// 模型输出或外部事件载荷——这些文本里出现短语不代表用户说过（PR #2911 审查实录：
// 盖章用了模型面请求，角色资产里一个子串就能免审批放行）。
//
// 所以发起话按「谁写的」定值，不按「这一轮发了什么」：
//   · 用户在聊天里打的字 → 原话（剥掉系统脚手架与 renderer 预置的 system-reminder）；
//   · 生产者显式声明的用户文本（定时任务的提示词正文）→ 声明值；
//   · 其余（系统生成的轮次、恢复的 run、IM 通道、带外部载荷）→ 没有发起话。
// 没有发起话 = preapprove 未命中 = 回落询问，绝不静默放行，也绝不静默拦死。
// ============================================================================

import type { AgentRunOptions } from '../research/types';
import type { MessageMetadata } from '../../shared/contract/message';
import { extractUserRequest, stripSystemReminderBlocks } from '../../shared/utils/turnScaffold';

type ProvenanceOptions = Pick<
  AgentRunOptions,
  'inputSource' | 'historyVisibility' | 'inputHistoryVisibility' | 'resumeExistingDurableRun'
  | 'displayContent' | 'initiatingUserText'
>;

function userWords(text: string): string | undefined {
  const words = stripSystemReminderBlocks(extractUserRequest(text)).trim();
  return words.length > 0 ? words : undefined;
}

/**
 * 本轮的发起话；undefined = 这一轮没有用户原话可供 preapprove 匹配。
 * content 传用户侧原文（不是拼好系统上下文的模型面请求）；即便传进来的是包装体
 * （排队 steer 的恢复路径），也只取 <user_request> 里那一段。
 */
export function resolveRunInitiatingText(
  content: string,
  options: ProvenanceOptions | undefined,
): string | undefined {
  const declared = options?.initiatingUserText;
  if (declared === null) return undefined;
  if (typeof declared === 'string') return userWords(declared);
  // 与 cancelTimeWakesOnUserReturn 同一条「这是不是用户本人回来说话」的边界：
  // 自动化输入与隐藏轮都是宿主生成的提示词（唤醒续跑、子代理回报、计划批准、loop 轮）。
  if (options?.inputSource === 'automation'
    || options?.historyVisibility === 'meta'
    || options?.inputHistoryVisibility === 'meta') return undefined;
  // 恢复既有 run：content 是落库的源消息，来源标记（自动化/外部载荷）没跟着 options
  // 回来，无法区分它当初是用户打的字还是定时任务拼的提示词——按没有处理。
  if (options?.resumeExistingDurableRun) return undefined;
  // 展示文案与模型输入分离（工作卡）：content 是生成的任务包，不是用户打的字。
  if (options?.displayContent !== undefined) return undefined;
  return userWords(content);
}

/**
 * 把消息元数据里的来源并进 options（executeMessage 调，messageMetadata 只在那里可见）：
 *   · IM 通道消息：发言人身份无从核实（群里任何人都能说出短语）→ 强制没有发起话；
 *   · 同条消息带外部载荷（memoryTainted）且生产者没声明用户文本 → 没有发起话。
 * 其余情况原样返回同一个对象。
 */
export function stampInputProvenance<T extends AgentRunOptions | undefined>(
  options: T,
  messageMetadata: Pick<MessageMetadata, 'channel' | 'memoryTainted'> | undefined,
): T | AgentRunOptions {
  const untrusted = Boolean(messageMetadata?.channel)
    || (messageMetadata?.memoryTainted === true && typeof options?.initiatingUserText !== 'string');
  if (!untrusted) return options;
  return { ...(options ?? { mode: 'normal' as const }), initiatingUserText: null };
}
