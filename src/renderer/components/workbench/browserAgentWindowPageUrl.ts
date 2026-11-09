// 空白页（about:blank / 空串）不是「用户看过的页面」：托管标签被回收后会残留这个地址，
// 若当作有效 URL，会盖住 surface 预览与留影里的最后一页，面板就停在空白上。
export function realPageValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'about:blank') return null;
  return trimmed;
}
