// create-role 回合收尾：模型常在终答末尾自写一行「打开<专家名>」假链接，
// 它既不是按钮也点不了（草稿态专家尚未安装，唯一入口是宿主确认卡）。
// 仅当本回合调用过 propose_role 且末行恰为 `<打开|进入|…> <roleId>` 时摘掉该行。
import type { Message } from '../../../shared/contract/message';

const OPEN_VERBS = '(?:打开|进入|前往|去看看|open|go\\s+to|view)';
const WRAPPER_PREFIX = /^[\s>\-*+→➜▶]+/u;
const WRAPPER_CHARS = /^[\s*_`"'“”‘’「」『』<>《》()（）[\]]+|[\s*_`"'“”‘’「」『』<>《》()（）[\]。.!！]+$/gu;

export function collectProposedRoleIds(messages: readonly Message[]): string[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].visibility !== 'rewound') { start = i + 1; break; }
  }
  const ids: string[] = [];
  for (const m of messages.slice(start)) {
    for (const call of m.toolCalls ?? []) {
      const roleId = call.name === 'propose_role' ? (call.arguments as Record<string, unknown> | undefined)?.roleId : undefined;
      if (typeof roleId === 'string' && roleId.trim()) ids.push(roleId.trim().toLowerCase());
    }
  }
  return ids;
}

export function stripRoleOpenLinkTail(content: string, roleIds: readonly string[]): { content: string; removedLine?: string; roleId?: string } {
  if (!roleIds.length) return { content };
  const lines = content.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  if (last < 0) return { content };
  const line = lines[last];
  const core = line.replace(WRAPPER_PREFIX, '').replace(WRAPPER_CHARS, '');
  const m = new RegExp(`^${OPEN_VERBS}\\s*(.+)$`, 'iu').exec(core);
  const name = m?.[1].replace(WRAPPER_CHARS, '').trim().toLowerCase();
  if (!name || !roleIds.includes(name)) return { content };
  return { content: lines.slice(0, last).join('\n').replace(/\s+$/, ''), removedLine: line, roleId: name };
}
