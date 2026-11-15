// 按调用的 action 解析「有效权限档」：同一工具名下不同 action 风险不同时，不能整体按声明档判。
// 先例：permissionClassifier.ts 的 MCPUNIFIED_READ_ONLY_ACTIONS。
// ExcelAutomate：read / list_sheets / get_range / validate_formulas 只读；automate 可跑宏，
// 在每个会询问的档位仍询问；edit / generate 保持写档（通用写边界照常生效），但没有 Excel 专属询问。
import type { ToolDefinition } from '../../shared/contract';

const EXCEL_AUTOMATE = 'ExcelAutomate';
const EXCEL_READ_ACTIONS = new Set(['read', 'list_sheets', 'get_range', 'validate_formulas']);

function excelAction(toolName: string, params: Record<string, unknown> | undefined): string | undefined {
  if (toolName !== EXCEL_AUTOMATE) return undefined;
  const action = params?.action;
  return typeof action === 'string' ? action : undefined;
}

/** 缺失 / 未知 action → 返回声明档（即写档，行为不变）。 */
export function effectivePermissionLevel<L extends string>(
  toolName: string,
  declared: L,
  params: Record<string, unknown> | undefined,
): L | 'read' {
  const action = excelAction(toolName, params);
  return action !== undefined && EXCEL_READ_ACTIONS.has(action) ? 'read' : declared;
}

/** 把定义换成「本次调用的有效定义」（仅 permissionLevel 可能不同）。 */
export function withEffectivePermissionLevel(
  definition: ToolDefinition,
  params: Record<string, unknown> | undefined,
): ToolDefinition {
  const level = effectivePermissionLevel(definition.name, definition.permissionLevel, params);
  return level === definition.permissionLevel ? definition : { ...definition, permissionLevel: level };
}

/** edit / generate：写档但无 Excel 专属询问（owner 11-14），分类器放行；通用写边界另行生效。 */
export function excelActionIsFileEdit(toolName: string, params: Record<string, unknown> | undefined): boolean {
  const action = excelAction(toolName, params);
  return action === 'edit' || action === 'generate';
}

/** acceptEdits 档下 ExcelAutomate 仅 automate（跑宏）仍必须询问；其它 action 不在此处询问。 */
export function excelActionMustAsk(toolName: string, params: Record<string, unknown> | undefined): boolean {
  if (toolName !== EXCEL_AUTOMATE) return false;
  const action = excelAction(toolName, params);
  return action === undefined || action === 'automate';
}
