import path from 'path';
import { COMPACTION_SUMMARY } from '../../shared/constants';
import type { ToolCall, ToolResult } from '../../shared/contract/tool';

/** Read/Edit/Write 类工具：被它们碰过的文件才是摘要必须逐字保留的路径。 */
const TOUCH_TOOL_RE = /^(?:read|read_file|file_read|edit|edit_file|write|write_file|file_write|multiedit|multi_edit|notebookedit|notebook_edit)$/i;

export interface TouchedPathMessage {
  toolCalls?: unknown;
}

/** 返回被文件类工具碰过的绝对路径，按最近一次触碰（消息序号）新→旧，最多 MAX_REQUIRED_PATHS 条。 */
export function recentTouchedPaths(messages: TouchedPathMessage[]): string[] {
  const latest = new Map<string, number>();
  messages.forEach((message, index) => {
    const calls = Array.isArray(message.toolCalls) ? (message.toolCalls as ToolCall[]) : [];
    for (const call of calls) {
      if (!TOUCH_TOOL_RE.test(call.name)) continue;
      const args = call.arguments || {};
      const raw = [args.file_path, args.path, args.notebook_path].find(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      );
      if (!raw || !path.isAbsolute(raw.trim())) continue;
      latest.set(path.resolve(raw.trim()), index);
    }
  });
  return [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, COMPACTION_SUMMARY.MAX_REQUIRED_PATHS)
    .map(([filePath]) => filePath);
}

function failedExitCode(result: ToolResult): boolean {
  const meta = result.metadata || {};
  const code = (result as unknown as { exitCode?: unknown }).exitCode ?? meta.exitCode ?? meta.code;
  if (typeof code === 'number') return code !== 0;
  if (typeof code === 'string' && code.trim() !== '') return Number(code) !== 0 && !Number.isNaN(Number(code));
  return false;
}

/** 结构化失败：工具结果 success===false 或非零退出码；取首个非空行，<= MAX_ERROR_LINE_CHARS。 */
export function structuredFailureLines(results: ToolResult[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    if (result.success !== false && !failedExitCode(result)) continue;
    const text = [result.error, result.output, result.metadata?.output]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
    const first = text.split('\n').map((line) => line.trim()).find(Boolean);
    if (!first) continue;
    lines.push(first.slice(0, COMPACTION_SUMMARY.MAX_ERROR_LINE_CHARS));
  }
  return lines;
}
