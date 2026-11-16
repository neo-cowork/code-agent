// ============================================================================
// 原生连接器意图判据 — 单一真源（N-FG-CONNECTOR-TOOLS）
// ----------------------------------------------------------------------------
// 「本轮输入命中连接器意图 × 设置里启用 × registry 就绪」→ 该连接器的读写工具名。
// 两个消费方共用，判据/正则只允许存在这一份：
//   1. agent/runtime/contextAssembly/deferredToolPreload.ts —— deferred 预载；
//   2. app/sessionCommandCenterBrain.ts —— 文字前台 per-turn allowlist 扩展
//      （ADR-059 修订：连接器工具按轮进面，不做 schema 常驻声明，防前缀缓存打掉）。
// ============================================================================

import type { Message } from '../../shared/contract/message';
import { isScheduleTaskChatIntent } from '../app/scheduleTaskChatIntent';
import { CONNECTOR_TOOL_NAMES } from '../../shared/contract/workbenchTools';
import { isCoreToolName } from '../services/toolSearch/deferredTools';
import { createLogger } from '../services/infra/logger';
import { getConnectorRegistry } from './registry';
import { getConfigService } from '../services/core/configService';

const logger = createLogger('ContextAssembly');

// 意图正则守则（issue #322）：\b 对 . / - 等非单词字符也成立，"notes.md" 能穿过
// \bnotes\b；裸词缺 \b 会被子串误命中（"express" 含 "press"）。误触的代价不止暴露
// 无关工具——工具表突变会整体打掉 provider 前缀缓存（PR#321 审计附录实测归因）。
// 所以：英文单词一律带 \b，高频语境词要求明确 app/动作搭配。
const NATIVE_CONNECTOR_INTENT_RES: ReadonlyArray<readonly [string, RegExp]> = [
  ['reminders', /提醒(?:事项|我)?|待办|\breminders?\b|\bto-?do\b|\bremind\s+me\b/i],
  ['mail', /邮件|邮箱|草稿|\be-?mails?\b|\bmail\b|\bdraft\b/i],
  ['calendar', /日程|日历|\bcalendar\b|\bschedule\s+(?:a|an|the)\s+(?:meeting|event)\b/i],
];

// Recurrence is only a loose scheduling exposure signal. Existing reminder reads
// and edits must keep their connector tools; foreground cannot discover them later.
const REMINDER_MANAGEMENT_INTENT_RE = /查看|查询|查找|列出|显示|修改|更改|调整|改到|改成|删除|取消|完成|推迟|提前|\b(?:show|list|view|read|find|search|get|update|edit|change|move|reschedule|delete|remove|cancel|complete|check)\b/i;

export interface NativeConnectorIntentInput {
  /** 本轮用户输入（最新一条 user 消息或前台 prompt 原文）。 */
  userText: string;
  /** Attended session history before this user message; never an authorization grant. */
  priorMessages?: readonly Pick<Message, 'role' | 'content' | 'isMeta' | 'visibility' | 'source'>[];
  /**
   * 用户本轮手选的连接器（web 工作台 toolScope.allowedConnectorIds）。
   * 非空 = 显式收窄：不在其中的连接器不追加。文字前台无手选时传 undefined。
   */
  allowedConnectorIds?: readonly string[];
}

// Carry only an explicit reference/parameter correction, stopping at the first topic change.
// A unique prior connector is required; ambiguous multi-connector turns do not guess a target.
const FOLLOWUP_PREFIX_RE = /^(?:(?:no[,\s]+wait|actually|instead|please|不对|等等|请|麻烦)[,，。!！\s]*)+/iu;
const CONNECTOR_FOLLOWUP_RE = /^(?:(?:make|move|change|reschedule|set|create|send|save|try|do|delete|cancel)\s+(?:it|that|this)\b|(?:change|set)\s+the\s+(?:time|date|title|recipient)\b|(?:把)?(?:它|这个|那个|刚才的)(?:改|换|设|建|创|发|存|删|取消|再)|(?:改成|改到|换成|再试一次|重新创建|重新发送))/iu;
const OTHER_TARGET_RE = /\b(?:file|folder|report|spreadsheet|document|code|function|website|image|video)\b|文件|文件夹|报告|表格|代码|函数|网页|图片|视频/iu;

function isConnectorFollowup(text: string): boolean {
  return !OTHER_TARGET_RE.test(text) && !isScheduleTaskChatIntent(text)
    && CONNECTOR_FOLLOWUP_RE.test(text.trim().replace(FOLLOWUP_PREFIX_RE, ''));
}

function explicitConnectorIntent(userText: string): string[] {
  return NATIVE_CONNECTOR_INTENT_RES
    .filter(([id, re]) => re.test(userText)
      && !(id === 'reminders' && isScheduleTaskChatIntent(userText)
        && !REMINDER_MANAGEMENT_INTENT_RE.test(userText)))
    .map(([id]) => id);
}

function connectorIntent(input: NativeConnectorIntentInput): string[] {
  const current = explicitConnectorIntent(input.userText);
  if (current.length || !isConnectorFollowup(input.userText)) return current;
  const history = input.priorMessages ?? [];
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role !== 'user' || message.isMeta || message.visibility === 'rewound'
      || (message.source && message.source !== 'user')) continue;
    const prior = explicitConnectorIntent(message.content);
    if (prior.length) return prior.length === 1 ? prior : [];
    if (!isConnectorFollowup(message.content)) break;
  }
  return [];
}

/**
 * 意图 × 启用 × 就绪 → 连接器工具名（core 工具除外，它们本就常驻）。
 * 无意图命中时零副作用（不触 configService/registry），无关轮次的前缀缓存不受影响。
 * 就绪口径与 cron.ipc / cronMailPoller 一致：unchecked（重启后未探测）仍算可用，
 * failed / unavailable 才排除——已授权用户不该被逼去再点一次。
 * 未启用/未注册只放读工具（见循环内注释）；failed / unavailable 分支不动。
 */
export function getNativeConnectorToolNamesForIntent(input: NativeConnectorIntentInput): string[] {
  const matched = connectorIntent(input);
  if (matched.length === 0) return [];

  let enabledNative: readonly string[] = [];
  try {
    enabledNative = getConfigService().getSettings().connectors?.enabledNative ?? [];
  } catch (error) {
    logger.warn('[ContextAssembly] Native connector preload skipped (reason: config-unavailable)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const scoped = input.allowedConnectorIds ?? [];
  const registry = getConnectorRegistry();
  const tools: string[] = [];
  // 未启用/未注册：只放读工具（各连接器清单首项），让模型调用后拿到「未连接，可在连接器页打开」
  // 的工具结果并转述，而不是在零信号下拿别处数据答「今天没有日程」。写工具一律不放。
  const exposeReadToolOnly = (connectorId: string): void => {
    const readTool = CONNECTOR_TOOL_NAMES[connectorId]?.[0];
    if (readTool && !isCoreToolName(readTool)) tools.push(readTool);
  };
  for (const connectorId of matched) {
    if (!enabledNative.includes(connectorId)) {
      logger.warn(`[ContextAssembly] Native connector not enabled, exposing read tool only (reason: not-enabled): ${connectorId}`);
      if (scoped.length === 0 || scoped.includes(connectorId)) exposeReadToolOnly(connectorId);
      continue;
    }
    // 用户本轮手选了别的连接器 = 显式收窄，不替他加。
    if (scoped.length > 0 && !scoped.includes(connectorId)) continue;
    const connector = registry.get(connectorId);
    if (!connector) {
      logger.warn(`[ContextAssembly] Enabled native connector missing from registry, exposing read tool only (reason: not-registered): ${connectorId}`);
      exposeReadToolOnly(connectorId);
      continue;
    }
    const readiness = connector.getCachedStatus?.().readiness;
    if (readiness === 'failed' || readiness === 'unavailable') {
      logger.warn(`[ContextAssembly] Enabled native connector not preloaded (reason: readiness-${readiness}): ${connectorId}`);
      continue;
    }
    for (const toolName of CONNECTOR_TOOL_NAMES[connectorId] ?? []) {
      if (!isCoreToolName(toolName)) tools.push(toolName);
    }
  }
  return tools;
}
