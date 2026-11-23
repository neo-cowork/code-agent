// ============================================================================
// GUI takeover disclosure — 本 run 首次直接驱动某 app 界面前，host 主动说一句话。
//
// 「先说一句再动屏幕」此前只是写给模型的提示词（prompts/base/tools.ts 的
// capability ladder 行 + cuaLadderGuidance 的 CUA_SCREEN_LADDER_TOOL_SUFFIX），两轮
// 提示词评测不达标（弱模型一言不发直接动屏幕）。本模块把这句话变成 host 行为：
// 判定只看工具调用本身，模型是否开口无关。
//
// 只做披露，不碰审批：审批卡照旧由 toolExecutor 的按应用授权 / 命令分类链路弹，
// 本模块不改任何审批/拒绝规则。豁免面：连接器工具（mail/calendar/reminders 等）
// 与不驱动界面的纯 Apple Events 数据读取本来就不在触发形状里，list_apps 等
// metadata 工具经 cuaToolNeedsAppGrant 排除。
//
// 应用身份只认 host 侧解析：cua-driver 走 resolveCuaAppTarget（pid/window_id
// 反查或 launch_app 参数），computer_use 走 extractComputerTargetApp（targetApp），
// shell 走 tell 目标解析——绝不采信模型自报的应用名。
// ============================================================================

import type { ToolCall } from '../../../shared/contract';
import {
  appGrantKey,
  extractComputerTargetApp,
  type ComputerTargetApp,
} from '../../permissions/computerAppTarget';
import { classifyShellDesktopAutomation, containsAppleScriptCommand } from '../../permissions/shellDesktopAutomation';
import { cuaToolNeedsAppGrant, resolveCuaAppTarget } from '../../permissions/cuaAppTarget';
import { isBashToolName } from '../../tools/toolNames';
import { logCollector } from '../../mcp/logCollector.js';
import type { RuntimeContext } from './runtimeContext';

// ----------------------------------------------------------------------------
// Shell (Bash/AppleScript) 触发形状表。
// ----------------------------------------------------------------------------

/** `tell process "Keynote"`（System Events 驱动时的真实 GUI 应用）。 */
const TELL_PROCESS_TARGET = /tell\s+(?:application\s+process|app\s+process|process)\s+(?:"([^"]+)"|'([^']+)')/i;

/** `tell application "Keynote"` / `tell app 'Keynote'`（引号目标）。 */
const TELL_APPLICATION_QUOTED = /\btell\s+(?:application|app)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)')/gi;

/** `tell application Keynote to …`（不带引号的单词目标）。 */
const TELL_APPLICATION_BARE = /tell\s+(?:application|app)\s+([A-Za-z][A-Za-z0-9.]*)\s+to\b/i;

const ACTIVATE_VERB = /(?:^|\n|\bto\s+|\s-e\s+['"])\s*activate(?=\s*(?:['";&|\r\n]|--|$))/i;

/**
 * 编辑打开中的文档：tell 目标块内 `set … of document/slide/…`（对象后面才轮到值）。
 * 只认 set-of-对象 形状；set 与 of 之间不许出现 `to`（`set x to name of document 1`
 * 是读取，不是编辑）；make/new 等结构性操作也不属于「编辑已打开的文档」。
 */
const OPEN_DOCUMENT_EDIT = /(?:^|\n|\bto\s+|\s-e\s+['"])\s*set\s+(?:(?!\bto\b)[^\n]){0,200}?\bof\s+(?:the\s+)?(?:front\s+)?(?:document|slide|sheet|page|cell|range|selection|word|paragraph|character|table|shape)\b/i;
const TELL_OPEN_DOCUMENT = /\btell\s+(?:the\s+)?(?:(?:front|current)\s+)?(?:document|slide|sheet|page|selection)\b/i;
const SET_PROPERTY = /(?:^|\n|\bto\s+|\s-e\s+['"])\s*set\s+(?:the\s+)?(?:name|title|object text|text|value|content|contents)(?:\s+of\s+(?:(?!\bto\b)[^\n]){1,200}?)?\s+to\b/i;
const SYSTEM_EVENTS_UI = /(?:^|\n|\bto\s+|\s-e\s+['"])\s*(?:click|keystroke|key\s+code|scroll)\b/i;

function firstCapture(command: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(command);
    // match[0] 是整段命中（含 "tell process" 前缀），只看捕获组。
    const captured = match?.slice(1).find((group) => typeof group === 'string' && group.trim() !== '');
    if (captured) return captured.trim();
  }
  return null;
}

/**
 * Shell 触发形状的目标应用：优先 `tell process "X"`（System Events 驱动下的真实
 * GUI 应用）；否则 `tell application "X"`，但 System Events 自己不算应用；解析不出
 * 应用名（如整桌面坐标注入没点名任何应用）就不披露——句子以应用名为主语，没有
 * 应用名宁可不说，也不编一个。
 */
function resolveShellGuiTargetApp(command: string): ComputerTargetApp | null {
  const usesAppleScript = containsAppleScriptCommand(command);
  const applications = Array.from(command.matchAll(TELL_APPLICATION_QUOTED));
  const isSystemEvents = (name: string) => /^system events$/i.test(name.trim());
  const hasSystemEvents = applications.some((match) => isSystemEvents(match[1] ?? match[2]));
  const directInput = classifyShellDesktopAutomation(command)
    || (usesAppleScript && hasSystemEvents && SYSTEM_EVENTS_UI.test(command));
  if (directInput && hasSystemEvents) {
    const process = firstCapture(command, [TELL_PROCESS_TARGET]);
    if (process) return { name: process };
  }
  const applicationTargets = applications.filter((match) => !isSystemEvents(match[1] ?? match[2]));
  for (const target of applicationTargets) {
    const afterTarget = command.slice(target.index + target[0].length);
    const body = afterTarget.split(/\bend\s+tell\b|\btell\s+app(?:lication)?\s+['"]/i, 1)[0];
    if (directInput || (usesAppleScript && (
      ACTIVATE_VERB.test(body)
      || OPEN_DOCUMENT_EDIT.test(body)
      || (TELL_OPEN_DOCUMENT.test(body) && SET_PROPERTY.test(body))
    ))) {
      return { name: (target[1] ?? target[2]).trim() };
    }
  }
  const bare = firstCapture(command, [TELL_APPLICATION_BARE]);
  if (bare && (directInput || (usesAppleScript && ACTIVATE_VERB.test(command)))) return { name: bare };
  return null;
}

// ----------------------------------------------------------------------------
// 触发判定（不依赖模型输出）+ 每 run 每应用一次。
// ----------------------------------------------------------------------------

type DisclosureAppResolution =
  | { kind: 'app'; app: ComputerTargetApp }
  | { kind: 'unresolved'; reason: string }
  | { kind: 'skip' };

async function resolveDisclosureApp(toolName: string, args: Record<string, unknown> | undefined): Promise<DisclosureAppResolution> {
  // cua-driver 原生工具：app-grant 面（app action + app-content read）且反查到应用。
  // list_apps / 整桌面读取等 metadata 工具在 cuaToolNeedsAppGrant 里就是 false，保持安静。
  // unresolved（该授权但身份没解析出来）必须单独返回，调用方打 WARN，不能和「不是接管」混成 null。
  if (cuaToolNeedsAppGrant(toolName)) {
    const resolution = await resolveCuaAppTarget(toolName, args);
    if (resolution.kind === 'app') return { kind: 'app', app: resolution.app };
    if (resolution.kind === 'unresolved') return { kind: 'unresolved', reason: resolution.reason };
    return { kind: 'skip' };
  }
  const computerTarget = extractComputerTargetApp(toolName, args);
  if (computerTarget) return { kind: 'app', app: computerTarget };
  if (isBashToolName(toolName) && typeof args?.command === 'string') {
    const shellTarget = resolveShellGuiTargetApp(args.command);
    if (shellTarget) return { kind: 'app', app: shellTarget };
  }
  return { kind: 'skip' };
}

const states = new WeakMap<RuntimeContext, Set<string>>();

/** Reset alongside the repair gate at the AgentLoop run boundary. */
export function resetGuiTakeoverDisclosureState(ctx: RuntimeContext): void {
  states.delete(ctx);
}

/**
 * 给本批工具调用里「本 run 首次直接驱动某 app 界面」的调用挂上结构化披露。
 * 就地写 toolCall.guiTakeoverDisclosure：随后落库的 assistant 消息、tool_call_start
 * 事件（引擎展开整个 toolCall）与执行期审批卡按此顺序到达用户。主 run 按
 * appGrantKey 去重，成员 run 按传输方式无关的应用名称去重。
 */
export async function attachGuiTakeoverDisclosures(scope: RuntimeContext | Set<string>, toolCalls: ToolCall[]): Promise<void> {
  if (toolCalls.length === 0) return;
  const memberRun = scope instanceof Set;
  const disclosed = memberRun ? scope : states.get(scope) ?? new Set<string>();
  if (!memberRun) states.set(scope, disclosed);
  for (const toolCall of toolCalls) {
    let decision: DisclosureAppResolution;
    try {
      decision = await resolveDisclosureApp(toolCall.name, toolCall.arguments);
    } catch (error) {
      // fail-open：披露判定抛错不拦工具、不改行为，但必须留下可区分的原因。
      // 这条只覆盖抛错；unresolved 走下面单独的 WARN，避免同一调用打两次。
      logCollector.tool('WARN', 'GUI takeover disclosure resolution failed (tool runs without disclosure)', {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (decision.kind === 'unresolved') {
      logCollector.tool('WARN', 'GUI takeover disclosure unresolved (tool runs without disclosure)', {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        reason: decision.reason,
      });
      continue;
    }
    if (decision.kind !== 'app') continue;
    const app = decision.app;
    // Member rows are per app name, including calls that switch between GUI transports.
    const key = memberRun ? app.name.trim().toLowerCase() : appGrantKey(app);
    if (disclosed.has(key)) continue;
    disclosed.add(key);
    toolCall.guiTakeoverDisclosure = { code: 'gui_takeover', app: app.name.trim() };
    logCollector.tool('INFO', `GUI takeover disclosure attached (${app.name.trim()})`, {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      appKey: key,
    });
  }
}
