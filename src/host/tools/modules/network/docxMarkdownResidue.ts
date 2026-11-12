/**
 * 扫 word/document.xml 里残留的字面 Markdown 标记。
 * 行首标记按「段落」判：同一 <w:p> 内各 <w:t> 先拼成段落文本，只看段首——
 * 行内粗体把段落切成多个 run，后续 run 以 " - " / " > " 开头是合法正文。
 * 纯文本编号（"1. 背景"）是合法标题/正文，不算残留。
 */
export function findMarkdownResidue(xml: string): string[] {
  const hits: string[] = [];
  if (/\*\*[^*\r\n]+\*\*/.test(xml)) hits.push('paired **bold** markers');
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  const leading = /^\s*(?:#{1,3}|[-*]|&gt;)\s+/;
  const hasLeading = paragraphs.some((p) => {
    const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('');
    return leading.test(text);
  });
  if (hasLeading) hits.push('leading list/heading markers');
  return hits;
}
