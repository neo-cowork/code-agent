/** 中文界面下判断一段推理文本是否以英文为主：CJK 字符占（CJK + 拉丁字母）的比例低于 0.3；无字母视为否。 */
export function isMostlyEnglish(text: string): boolean {
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  if (cjk + latin === 0) return false;
  return cjk / (cjk + latin) < 0.3;
}
