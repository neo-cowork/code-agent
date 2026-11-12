// ============================================================================
// envAssist 测试共用的「真实连接器工具失败路径」驱动器（Rework r9）。
//
// 之前 envAssist*.test.ts 直接手搓 `metadata: { code: 'not_authorized' }`，把
// mail/reminders 工具模块 osascript 失败分支从不带 code 的缺口整个遮住了
// （生产里这两条 AUTOMATION_TARGETS 永远发不出环境卡片）。这里改为：
//   真工具模块 handler + 真原生连接器 + 假 runAppleScript（测试文件 vi.mock 注入，
//   用真实 Apple Events 拒绝文本 -1743 拒绝），code 由被测代码真实产出。
// 唯一手工保留的是 toolResolver 的 proto 失败映射（3 行，见 protoFailure）。
// ============================================================================
import type { CanUseToolFn, Logger, ToolContext, ToolResult } from '../../../../src/host/protocol/tools';
import { getConnectorRegistry } from '../../../../src/host/connectors/registry';
import { calendarConnector } from '../../../../src/host/connectors/native/calendar';
import { mailConnector } from '../../../../src/host/connectors/native/mail';
import { remindersConnector } from '../../../../src/host/connectors/native/reminders';
import { calendarModule } from '../../../../src/host/tools/modules/connectors/calendar';
import { mailModule } from '../../../../src/host/tools/modules/connectors/mail';
import { remindersModule } from '../../../../src/host/tools/modules/connectors/reminders';
import { remindersCreateModule } from '../../../../src/host/tools/modules/connectors/remindersCreate';

/** TCC 拒绝 Apple Events 时 osascript 真实报错形态（execFile error + stderr）。 */
export function appleEventsDeniedError(app: string): Error {
  return Object.assign(
    new Error(`Command failed: osascript -e tell application "${app}"`),
    { stderr: `execution error: Not authorized to send Apple events to ${app}. (-1743)`, code: 1 },
  );
}

/** classify AUTOMATION_TARGETS 的四个工具名（reminders_create 复用 reminders 连接器）。 */
export type AutomationConnectorTool = 'calendar' | 'mail' | 'reminders' | 'reminders_create';

const TOOL_MODULES = {
  calendar: calendarModule,
  mail: mailModule,
  reminders: remindersModule,
  reminders_create: remindersCreateModule,
} as const;

const CONNECTOR_IDS: Record<AutomationConnectorTool, 'calendar' | 'mail' | 'reminders'> = {
  calendar: 'calendar',
  mail: 'mail',
  reminders: 'reminders',
  reminders_create: 'reminders',
};

/** 每个工具触发 Apple Events 拒绝所需的最小入参与目标 app 名。 */
export const AUTOMATION_FAILURE_CASES: Record<AutomationConnectorTool, { args: Record<string, unknown>; app: string; target: string }> = {
  calendar: { args: { action: 'list_events' }, app: 'Calendar', target: 'calendar' },
  mail: { args: { action: 'list_accounts' }, app: 'Mail', target: 'mail' },
  reminders: { args: { action: 'list_reminders' }, app: 'Reminders', target: 'reminders' },
  // create 先失败、reconcile 的 list_reminders 再失败：runAppleScript 持续拒绝即可走进
  // 「reconcile list 失败」分支，返回带 not_authorized 的失败结果。
  reminders_create: { args: { title: '测试提醒' }, app: 'Reminders', target: 'reminders' },
};

const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeConnectorToolContext(sessionId: string): ToolContext {
  return {
    sessionId,
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: { debug: () => void 0, info: () => void 0, warn: () => void 0, error: () => void 0 } as Logger,
    emit: () => void 0,
  } as unknown as ToolContext;
}

/**
 * 注册真原生连接器并跑真工具模块 handler；用完即反注册（也复位连接器 readiness 缓存）。
 * runAppleScript 由调用方测试文件的 vi.mock 假掉（本文件不 import osascript 模块）。
 */
export async function runConnectorToolFailure(
  tool: AutomationConnectorTool,
  sessionId: string,
): Promise<ToolResult<string>> {
  const registry = getConnectorRegistry();
  const connectorId = CONNECTOR_IDS[tool];
  const native = connectorId === 'calendar' ? calendarConnector
    : connectorId === 'mail' ? mailConnector
      : remindersConnector;
  registry.unregister(connectorId);
  registry.register(native);
  try {
    const handler = await TOOL_MODULES[tool].createHandler();
    return await handler.execute(
      AUTOMATION_FAILURE_CASES[tool].args,
      makeConnectorToolContext(sessionId),
      allowAll,
    );
  } finally {
    registry.unregister(connectorId);
  }
}

/** toolResolver 的 proto 失败映射（src/host/tools/dispatch/toolResolver.ts:187-191）：顶层 code → metadata.code。 */
export function protoFailure(moduleResult: Extract<ToolResult<string>, { ok: false }>): {
  success: false; error: string; metadata: Record<string, unknown>;
} {
  return {
    success: false,
    error: moduleResult.error,
    metadata: { code: moduleResult.code, ...(moduleResult.meta ?? {}) },
  };
}
