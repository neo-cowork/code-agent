// 记忆描述里模型会按 MemoryWrite 工具说明把 "Keywords: a, b" 检索词串写进 description；
// 专家记录页只给人看，去掉这段尾巴（存储内容不变，仅显示层）。
const KEYWORD_TAIL = /\s*(?:Keywords?|关键词)\s*[:：][^]*$/i;

export function plainMemoryDescription(description: string): string {
  const stripped = description.replace(KEYWORD_TAIL, '').trim();
  return stripped || description;
}
