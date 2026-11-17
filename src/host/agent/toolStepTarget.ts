const TOOL_TARGET_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'agentId', 'targetApp'] as const;
const COMMAND_PREVIEW_LENGTH = 80;

export function extractToolStepTarget(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  for (const key of TOOL_TARGET_KEYS) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (!normalized) continue;
    return key === 'command'
      ? Array.from(normalized).slice(0, COMMAND_PREVIEW_LENGTH).join('')
      : normalized;
  }
  return undefined;
}

/** Bash 的 arguments.description 原样带给渲染端（过滤在渲染端做）；只读 description，不读 shortDescription。 */
export function bashStepDescription(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (toolName !== 'Bash' && toolName !== 'bash') return undefined;
  const value = args?.description;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;
}
