/**
 * 模型输出里的 think / 工具协议裸标记：宿主提取与所有用户可见出口共用的单一实现。
 *
 * 孤儿 `</think>`（没有前置 `<think>`）：部分模型的推理模板把开标签放进 prompt，流里只剩闭标签
 * （vLLM deepseek_r1_reasoning_parser 同款场景）。此时闭标签之前是推理、之后是正文。
 * 已知损失：围栏代码块里字面出现的 `</think>` 也会被当成孤儿闭标签。
 */

const COMPLETE_THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;
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

/** 把 content 里的 think 内容并入 reasoning：完整块、孤儿 `</think>`（前→推理、后→正文）、未闭合 `<think>`（到串尾）。 */
export function splitThinkTags(
  content: string,
  reasoning: string,
): { content: string; reasoning: string } {
  let nextReasoning = reasoning;
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
  let thinkMatch;
  while ((thinkMatch = thinkRegex.exec(content)) !== null) {
    // 与旧实现逐字节一致：空块也沿用旧的拼接（含换行）
    nextReasoning += (nextReasoning ? '\n' : '') + thinkMatch[1].trim();
  }
  let nextContent = content.replace(COMPLETE_THINK_BLOCK, '');

  // 完整块已移除，剩下的 </think> 必然没有前置 <think>
  const orphanIndex = nextContent.indexOf('</think>');
  if (orphanIndex !== -1) {
    nextReasoning = appendReasoning(nextReasoning, nextContent.slice(0, orphanIndex).trim());
    nextContent = nextContent.slice(orphanIndex + '</think>'.length).replace(/<\/think>/g, '');
  }

  const unclosedIndex = nextContent.indexOf('<think>');
  if (unclosedIndex !== -1) {
    nextReasoning = appendReasoning(
      nextReasoning,
      nextContent.slice(unclosedIndex + '<think>'.length).trim(),
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
