// ============================================================================
// Write target path — 写入类工具目标路径的唯一取法
// ============================================================================
// permissionClassifier（W1 写边界）与 cronWriteGrant（定时任务写授权）必须对同一次
// 工具调用得出同一个目标，否则分类器放行「工作区内」的写入会被授权侧看成「无目标」而漏拦。
// 生成器类工具（docx_generate/excel_generate）的产物路径是可选参数：缺省落会话工作目录。

export const GENERATOR_WRITE_TOOLS: ReadonlySet<string> = new Set(['docx_generate', 'excel_generate']);

/** file_path → path → output_path；生成器缺省为 '.'；都没有返回 undefined。 */
export function writeTargetPathOf(toolName: string | undefined, args: Record<string, unknown> | undefined): string | undefined {
  const pick = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
  return pick(args?.file_path) ?? pick(args?.path) ?? pick(args?.output_path)
    ?? (toolName && GENERATOR_WRITE_TOOLS.has(toolName) ? '.' : undefined);
}
