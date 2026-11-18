// ============================================================================
// directiveMemoryConfirmView —— 全局记忆确认卡的结构化内容（语言中立）
//
// 两条不变量由同一机制保证，而不是逐形状打补丁：
//  (A) 将要落盘的每个字符串都在卡上：已知形状只负责「怎么摆」，最后一道兜底把
//      params 里所有没被摆出来的非空字符串叶子（文档序、只取值）补成普通行；
//      未知工具/未知字段因此不可能被藏起来。
//  (B) 卡上没有标识符：只放值，不放工具名/参数名/JSON；隐藏的只有下面这个很小的
//      控制字段集合。
// ============================================================================

import * as fs from 'node:fs';
import type { MemoryConfirmView, MemoryConfirmViewItem } from '../../shared/contract/memory';
import { normalizeEditArgs } from '../../shared/utils/editToolArgs';

/** 控制字段：决定「怎么写」而不是「写什么」，值本身不是内容。 */
const CONTROL_KEYS: ReadonlySet<string> = new Set(['action', 'scope', 'type', 'replace_all', 'replaceAll']);

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function collectLeaves(value: unknown, skipKeys: ReadonlySet<string>, out: string[]): void {
  if (typeof value === 'string') {
    if (value.trim() !== '') out.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectLeaves(entry, skipKeys, out);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!skipKeys.has(key)) collectLeaves(entry, skipKeys, out);
    }
  }
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.md$/i, '').replace(/[_-]+/g, ' ').trim();
}

function shapeItems(
  toolName: string,
  params: Record<string, unknown>,
  targets: readonly string[],
): { items: MemoryConfirmViewItem[]; skipKeys: Set<string> } {
  const items: MemoryConfirmViewItem[] = [];
  const skipKeys = new Set(CONTROL_KEYS);

  if (toolName === 'MemoryWrite') {
    skipKeys.add('filename');
    if (params.action === 'delete') {
      const title = str(params.name) ?? titleFromFilename(str(params.filename) ?? '');
      if (title) items.push({ kind: 'delete', title });
      return { items, skipKeys };
    }
    const content = str(params.content);
    if (content) items.push({ kind: 'remember', text: content });
    const description = str(params.description);
    if (description) items.push({ kind: 'description', text: description });
    const name = str(params.name);
    if (name) items.push({ kind: 'name', text: name });
    if (targets.some((target) => fs.existsSync(target))) items.push({ kind: 'replaces' });
    return { items, skipKeys };
  }

  if (toolName === 'Bash') {
    const command = str(params.command);
    if (command) items.push({ kind: 'command', text: command });
    return { items, skipKeys };
  }

  if (toolName === 'Write') {
    const filePath = str(params.file_path);
    if (filePath) items.push({ kind: 'path', text: filePath });
    const content = str(params.content);
    if (content) items.push({ kind: 'body', text: content });
    return { items, skipKeys };
  }

  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'edit_file') {
    const normalized = normalizeEditArgs(params);
    if (normalized) {
      items.push({ kind: 'path', text: normalized.filePath });
      for (const edit of normalized.edits) items.push({ kind: 'change', from: edit.oldText, to: edit.newText });
    }
  }
  return { items, skipKeys };
}

export function buildDirectiveMemoryConfirmView(input: {
  toolName: string;
  params: Record<string, unknown>;
  targets: readonly string[];
}): MemoryConfirmView {
  const { items, skipKeys } = shapeItems(input.toolName, input.params, input.targets);
  const shown = new Set<string>();
  for (const item of items) {
    if ('text' in item) shown.add(item.text);
    if (item.kind === 'change') {
      shown.add(item.from);
      shown.add(item.to);
    }
  }
  const leaves: string[] = [];
  collectLeaves(input.params, skipKeys, leaves);
  for (const leaf of leaves) {
    if (shown.has(leaf)) continue;
    shown.add(leaf);
    items.push({ kind: 'line', text: leaf });
  }
  return { items };
}
