// 记忆描述的展示投影：模型会在 description 末尾追加给召回用的「Keywords: ...」，
// 那是检索线索不是给用户读的话。只在展示面去掉，存储不动。
const KEYWORDS_TAIL = /[\s.。;；,，]*(?:keywords|关键词)\s*[:：][^\n]*$/i;

export function stripKeywordsTail(description: string): string {
  return description.replace(KEYWORDS_TAIL, '').trim();
}
