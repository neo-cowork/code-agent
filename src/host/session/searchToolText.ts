// 工具行（role: 'tool'）的 content 是 JSON.stringify(toolResults)：用户记得的文字
// 在各条结果的 output / error 字符串里。搜索与摘要只看这些文字，不展示 JSON 外壳。

// Read 工具输出的内部包装：首行版本摘要 + 每行行号前缀（`     1\t`）+ 末尾 <document-evidence> 来源锚，不是用户记得的内容。
const READ_DIGEST_LINE = /^Read version digest: [a-f0-9]+\r?\n/i;
const DOCUMENT_EVIDENCE_TAIL = /\s*<document-evidence>[\s\S]*?<\/document-evidence>\s*$/;
const LINE_NUMBER_GUTTER = /^[ ]*\d+\t/gm;

function stripToolWrapper(output: string): string {
  return output.replace(READ_DIGEST_LINE, '').replace(LINE_NUMBER_GUTTER, '').replace(DOCUMENT_EVIDENCE_TAIL, '');
}

export function extractToolOutputText(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const texts: string[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const { output, error } = item as { output?: unknown; error?: unknown };
      if (typeof output === 'string' && output) texts.push(stripToolWrapper(output));
      else if (typeof error === 'string' && error) texts.push(error);
    }
    if (texts.length > 0) return texts.join('\n');
  } catch {
    // 非 JSON：回落原文
  }
  return content;
}

/** 同相关度下 user/assistant/system 排在 tool 之前。 */
export function searchRoleRank(role: string): number {
  return role === 'tool' ? 1 : 0;
}
