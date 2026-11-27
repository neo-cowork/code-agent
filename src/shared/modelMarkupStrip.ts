/**
 * 模型输出里的 think / 工具协议裸标记：宿主提取与所有用户可见出口共用的单一实现。
 *
 * 完整 think 块归入推理。vLLM 兼容流可能把推理尾段放进正文，以孤儿 `</think>` 收尾；
 * 此时最后一个闭标签前的文字也归入推理。正文中间的孤儿闭标签仅在没有独立推理、
 * 也没有开标签时充当分隔符。已有独立推理时，未闭合的开标签只剥标记。
 */

const OPEN_THINK = '<think>';
const CLOSE_THINK = '</think>';
const THINK_TAGS = /<\/?think>/g;
const LONGCAT_PATTERNS = [
  /<longcat_tool_call>[\s\S]*?<\/longcat_tool_call>/gi,
  /<longcat_tool_call>[\s\S]*$/gi,
  /<longcat_arg_key>[\s\S]*?<\/longcat_arg_key>/gi,
  /<longcat_arg_value>[\s\S]*?<\/longcat_arg_value>/gi,
  /<\/?longcat_(?:arg_key|arg_value|tool_call|tool_result)\s*\/?>/gi,
];

function appendReasoning(reasoning: string, extra: string): string {
  return extra ? reasoning + (reasoning ? '\n' : '') + extra : reasoning;
}

/** 从模型正文提取推理并剥除残留的 think 标签。 */
export function splitThinkTags(
  content: string,
  reasoning: string,
): { content: string; reasoning: string } {
  const hasOpen = content.includes(OPEN_THINK);
  const lastClose = content.lastIndexOf(CLOSE_THINK);
  if (!hasOpen && lastClose === -1) return { content, reasoning };

  let nextReasoning = reasoning;
  let lastCompleteEnd = -1;
  let nextContent = content.replace(/<think>([\s\S]*?)<\/think>/g, (block, inner: string, offset: number) => {
    // 与旧实现逐字节一致：空块也沿用旧的拼接（含换行）
    nextReasoning += (nextReasoning ? '\n' : '') + inner.trim();
    lastCompleteEnd = offset + block.length;
    return '';
  });

  const closeEnd = lastClose + CLOSE_THINK.length;
  if (lastClose !== -1 && closeEnd !== lastCompleteEnd && closeEnd === content.trimEnd().length) {
    const extra = content.slice(0, lastClose).replace(THINK_TAGS, '').trim();
    return { content: '', reasoning: appendReasoning(reasoning, extra) };
  }

  const orphanIndex = nextContent.indexOf(CLOSE_THINK);
  if (orphanIndex !== -1) {
    if (reasoning || hasOpen) {
      nextContent = nextContent.replaceAll(CLOSE_THINK, '');
    } else {
      nextReasoning = appendReasoning(nextReasoning, nextContent.slice(0, orphanIndex).trim());
      nextContent = nextContent.slice(orphanIndex + CLOSE_THINK.length).replaceAll(CLOSE_THINK, '');
    }
  }

  if (reasoning) {
    nextContent = nextContent.replaceAll(OPEN_THINK, '');
    return { content: lastCompleteEnd === -1 ? nextContent : nextContent.trim(), reasoning: nextReasoning };
  }

  const unclosedIndex = nextContent.indexOf(OPEN_THINK);
  if (unclosedIndex !== -1) {
    nextReasoning = appendReasoning(
      nextReasoning,
      nextContent.slice(unclosedIndex + OPEN_THINK.length).trim(),
    );
    nextContent = nextContent.slice(0, unclosedIndex);
  }

  return { content: nextContent.trim(), reasoning: nextReasoning };
}

/** 展示出口用：丢弃所有 think 内容（含孤儿闭标签之前的推理），不返回推理。 */
export function stripThinkMarkup(text: string): string {
  if (!text?.includes('think>')) return text;
  return splitThinkTags(text, '').content;
}

/** 只剥 LongCat 工具协议裸标记（落库/转录路径用，不碰 think：正文里的字面 think 标签可能是代码示例）。 */
export function stripLongcatMarkup(content: string): string {
  if (!content?.includes('longcat_')) return content;
  let cleaned = content;
  for (const pattern of LONGCAT_PATTERNS) cleaned = cleaned.replace(pattern, '');
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

/** 仅用于「只给人看、不落库」的展示出口：think + LongCat 裸标记。无标记时原样返回。 */
export function stripModelMarkup(text: string): string {
  if (!text) return text;
  return stripLongcatMarkup(stripThinkMarkup(text));
}

/**
 * 后台任务结果卡与「有没有可用结论」共用的剥除。
 * 先剥 think / LongCat，再剥 Hermes/Qwen 式 <tool_call>（闭合块、未闭合到串尾、残留闭标签）。
 * 主链路转录不走这里：讲解性的 <tool_call> 字面量要留在正文里。
 */
export function stripCardToolCallMarkup(text: string): string {
  const cleaned = stripModelMarkup(text)
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*$/g, '')
    .replace(/<\/tool_call>/g, '');
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}
