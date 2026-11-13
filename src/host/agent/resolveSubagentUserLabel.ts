/** The model-given name wins; the task is the unnamed subagent's label. */
export function resolveSubagentUserLabel(input: { name?: unknown; task?: unknown }): string {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const task = typeof input.task === 'string' ? input.task.trim() : '';
  return name || task;
}
