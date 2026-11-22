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
import { classifyShellDesktopAutomation } from '../../permissions/shellDesktopAutomation';
import { cuaToolNeedsAppGrant, resolveCuaAppTarget } from '../../permissions/cuaAppTarget';
import { isBashToolName } from '../../tools/toolNames';
import { logCollector } from '../../mcp/logCollector.js';
import type { RuntimeContext } from './runtimeContext';

// ----------------------------------------------------------------------------
// Shell (Bash/osascript) 触发形状表：唯一维护点，正/负例测试都对着这张表。
// ----------------------------------------------------------------------------

/** `tell process "Keynote"`（System Events 驱动时的真实 GUI 应用）。 */
const TELL_PROCESS_TARGET = /tell\s+(?:application\s+process|app\s+process|process)\s+(?:"([^"]+)"|'([^']+)')/i;

/** `tell application "Keynote"` / `tell app 'Keynote'`（引号目标）。 */
const TELL_APPLICATION_QUOTED = /tell\s+(?:application|app)\s+(?:"([^"]+)"|'([^']+)')/i;

/** `tell application Keynote to …`（不带引号的单词目标）。 */
const TELL_APPLICATION_BARE = /tell\s+(?:application|app)\s+([A-Za-z][A-Za-z0-9.]*)\s+to\b/i;

/** 激活应用：tell 目标在场的前提下出现 activate 动词（如 `to activate`）。 */
const ACTIVATE_VERB = /\bactivate\b/i;

/**
 * 编辑打开中的文档：tell 目标块内 `set … of document/slide/…`（对象后面才轮到值）。
 * 只认 set-of-对象 形状；set 与 of 之间不许出现 `to`（`set x to name of document 1`
 * 是读取，不是编辑）；make/new 等结构性操作也不属于「编辑已打开的文档」。
 */
const OPEN_DOCUMENT_EDIT = /\bset\s+(?:(?!\bto\b)[^\n]){0,200}?\bof\s+(?:the\s+)?(?:front\s+)?(?:document|slide|sheet|page|cell|range|selection|word|paragraph|character|table|shape)\b/i;

export type ShellGuiTakeoverShape = 'system-events-input' | 'activate' | 'document-edit';

/** Bash/osascript 命令是否直接驱动某 app 的界面（不要求能解析出应用名）。 */
export function classifyShellGuiTakeover(command: string): ShellGuiTakeoverShape | null {
  if (typeof command !== 'string' || command.trim() === '') return null;
  // System Events 点击/按键/滚动等 GUI 输入合成（与审批链共用同一判据，不重复造表）。
  if (classifyShellDesktopAutomation(command)) return 'system-events-input';
  if (ACTIVATE_VERB.test(command)) return 'activate';
  if (OPEN_DOCUMENT_EDIT.test(command)) return 'document-edit';
  return null;
}

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
export function resolveShellGuiTargetApp(command: string): ComputerTargetApp | null {
  const process = firstCapture(command, [TELL_PROCESS_TARGET]);
  if (process) return { name: process };
  const application = firstCapture(command, [TELL_APPLICATION_QUOTED, TELL_APPLICATION_BARE]);
  if (application && !/^system events$/i.test(application)) return { name: application };
  return null;
}

// ----------------------------------------------------------------------------
// 触发判定（不依赖模型输出）+ 每 run 每应用一次。
// ----------------------------------------------------------------------------

async function resolveDisclosureApp(toolName: string, args: Record<string, unknown> | undefined): Promise<ComputerTargetApp | null> {
  // cua-driver 原生工具：app-grant 面（app action + app-content read）且反查到应用。
  // list_apps / 整桌面读取等 metadata 工具在 cuaToolNeedsAppGrant 里就是 false。
  if (cuaToolNeedsAppGrant(toolName)) {
    const resolution = await resolveCuaAppTarget(toolName, args);
    return resolution.kind === 'app' ? resolution.app : null;
  }
  const computerTarget = extractComputerTargetApp(toolName, args);
  if (computerTarget) return computerTarget;
  if (isBashToolName(toolName) && typeof args?.command === 'string') {
    if (!classifyShellGuiTakeover(args.command)) return null;
    return resolveShellGuiTargetApp(args.command);
  }
  return null;
}

type DisclosureState = { disclosed: Set<string> };

const states = new WeakMap<RuntimeContext, DisclosureState>();

/** run 边界重置（agentLoop / conversationRuntime 的 run 起点各调一次，与 resetRepairGate 同点位）。 */
export function resetGuiTakeoverDisclosureState(ctx: RuntimeContext): void {
  states.delete(ctx);
}

/**
 * 给本批工具调用里「本 run 首次直接驱动某 app 界面」的调用挂上结构化披露。
 * 就地写 toolCall.guiTakeoverDisclosure：随后落库的 assistant 消息、tool_call_start
 * 事件（引擎展开整个 toolCall）与执行期审批卡按此顺序到达用户。每 appGrantKey
 * 一次（大小写/trim 归一，bundle 优先），第二个 app 各自再披露一次。
 */
export async function attachGuiTakeoverDisclosures(ctx: RuntimeContext, toolCalls: ToolCall[]): Promise<void> {
  if (toolCalls.length === 0) return;
  let state = states.get(ctx);
  if (!state) {
    state = { disclosed: new Set<string>() };
    states.set(ctx, state);
  }
  for (const toolCall of toolCalls) {
    let app: ComputerTargetApp | null;
    try {
      app = await resolveDisclosureApp(toolCall.name, toolCall.arguments);
    } catch (error) {
      // fail-open：披露判定失败不拦工具、不改行为，但必须留下可区分的原因。
      logCollector.tool('WARN', 'GUI takeover disclosure resolution failed (tool runs without disclosure)', {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!app) continue;
    const key = appGrantKey(app);
    if (state.disclosed.has(key)) continue;
    state.disclosed.add(key);
    toolCall.guiTakeoverDisclosure = { code: 'gui_takeover', app: app.name.trim() };
    logCollector.tool('INFO', `GUI takeover disclosure attached (${app.name.trim()})`, {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      appKey: key,
    });
  }
}
