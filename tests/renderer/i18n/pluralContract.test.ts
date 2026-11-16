// 契约：整个 en/zh 文案包里，每个 { one, other } 对都必须自洽；
// zh 对与转换前的单串逐字等价（1 和 2 渲染一致）；英文文案不含中文标点。
import { describe, expect, it } from 'vitest';
import { interpolate, interpolatePlural } from '../../../src/renderer/i18n/interpolate';
import { getSurfaceExecutionTranslations } from '../../../src/renderer/i18n/surfaceExecution';
import baseline from './fixtures/pluralBaseline.json';

const modules = import.meta.glob('../../../src/renderer/i18n/*.ts', { eager: true }) as Record<string, Record<string, unknown>>;

type Pair = { one: string; other: string };
interface Found { exportName: string; path: string; value: Pair }

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPair = (v: unknown): v is Pair => {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v).sort();
  return keys.length === 2 && keys[0] === 'one' && keys[1] === 'other' && typeof v.one === 'string' && typeof v.other === 'string';
};
const isEnglishExport = (name: string) => /^en([A-Z]|$)/.test(name) || /En$/.test(name);
const isChineseExport = (name: string) => /^zh([A-Z]|$)/.test(name) || /Zh$/.test(name);

const pairs: Found[] = [];
const englishStrings: Array<{ where: string; text: string }> = [];
function walk(exportName: string, value: unknown, path: string[]): void {
  if (isPair(value)) {
    pairs.push({ exportName, path: path.join('.'), value });
    if (isEnglishExport(exportName)) {
      englishStrings.push({ where: `${exportName}.${path.join('.')}.one`, text: value.one });
      englishStrings.push({ where: `${exportName}.${path.join('.')}.other`, text: value.other });
    }
    return;
  }
  if (typeof value === 'string') {
    if (isEnglishExport(exportName)) englishStrings.push({ where: `${exportName}.${path.join('.')}`, text: value });
    return;
  }
  if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) walk(exportName, v, [...path, k]);
}
for (const mod of Object.values(modules)) {
  for (const [name, value] of Object.entries(mod)) {
    if (isPlainObject(value) && (isEnglishExport(name) || isChineseExport(name))) walk(name, value, []);
  }
}
// surfaceExecutionEn 不导出，只能经入口函数取到。
walk('surfaceExecutionEn', getSurfaceExecutionTranslations('en'), []);

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const hasCjk = (text: string) => /[㐀-鿿]/.test(text);
const keyOf = (f: Found) => `${f.exportName}.${f.path}`;

describe('plural pair contract (en + zh bundles)', () => {
  it('finds the converted pairs', () => {
    expect(pairs.length).toBeGreaterThan(150);
  });

  it('every pair keeps the same placeholders in one and other', () => {
    const bad = pairs.filter((p) => placeholders(p.value.one) !== placeholders(p.value.other)).map(keyOf);
    expect(bad).toEqual([]);
  });

  it('every English pair has different one/other text', () => {
    const bad = pairs.filter((p) => isEnglishExport(p.exportName) && p.value.one === p.value.other).map(keyOf);
    expect(bad).toEqual([]);
  });

  it('every Chinese pair is one === other (no plural form in zh)', () => {
    // localOps 的 zh 包里历史上放的是英文串（无 CJK），它按英文规则处理。
    const bad = pairs
      .filter((p) => isChineseExport(p.exportName) && hasCjk(p.value.one + p.value.other) && p.value.one !== p.value.other)
      .map(keyOf);
    expect(bad).toEqual([]);
  });

  it('every converted string still exists as a pair, and `other` / zh text equals the pre-conversion string', () => {
    const byKey = new Map(pairs.map((p) => [keyOf(p), p]));
    const missing: string[] = [];
    const changed: string[] = [];
    for (const [key, original] of Object.entries(baseline as Record<string, string>)) {
      const found = byKey.get(key);
      if (!found) { missing.push(key); continue; }
      // thinkingLayerLabel 的第二个 {count} 改名为 {repeats}（interpolate 只替换第一处）。
      const other = found.value.other.replaceAll('{repeats}', '{count}');
      const one = found.value.one.replaceAll('{repeats}', '{count}');
      if (other !== original) changed.push(`${key}: other ${JSON.stringify(other)} !== ${JSON.stringify(original)}`);
      if (isChineseExport(found.exportName) && hasCjk(original) && one !== original) changed.push(`${key}: zh one`);
    }
    expect(missing).toEqual([]);
    expect(changed).toEqual([]);
  });

  it('zh renders identically to the old single string at count 1 and 2', () => {
    const params = { app: 'A', tokens: 'T', confidence: 'C', unitPrice: 'U', total: 'TT', shown: 'S' };
    for (const [key, original] of Object.entries(baseline as Record<string, string>)) {
      const exportName = key.split('.')[0];
      if (!isChineseExport(exportName) || !hasCjk(original)) continue;
      const pair = pairs.find((p) => keyOf(p) === key)!;
      for (const n of [1, 2]) {
        // thinkingLayerLabel 里同一个 count 出现两次：旧消费方用 replaceAll，新模板第二处改名 {repeats}。
        const expected = original.replaceAll('{count}', String(n));
        expect(interpolatePlural(pair.value, n, { ...params, repeats: n })).toBe(interpolate(expected, params));
      }
    }
  });

  it('English singular reads singular at 1 and plural at 2 for a few keys that the UI really shows', () => {
    const find = (k: string) => pairs.find((p) => keyOf(p) === k)!.value;
    expect(interpolatePlural(find('chatTranscriptEn.chat.delegationReceipt.steps'), 1)).toBe('Completed 1 step');
    expect(interpolatePlural(find('chatTranscriptEn.chat.delegationReceipt.steps'), 2)).toBe('Completed 2 steps');
    expect(interpolatePlural(find('decisionCardEn.decisionCard.permission.fileCount'), 1)).toBe(' (1 file)');
    expect(interpolatePlural(find('decisionCardEn.decisionCard.permission.fileCount'), 2)).toBe(' (2 files)');
  });
});

describe('English copy uses ASCII punctuation', () => {
  it('no English bundle string contains CJK punctuation', () => {
    // 分词演示里原样引用一句中文例句并附英文翻译，是内容本身，不是分隔符。
    const quotedChineseExample = /demoStep1Example$/;
    const bad = englishStrings
      .filter((s) => /[、，；]/.test(s.text) && !quotedChineseExample.test(s.where))
      .map((s) => `${s.where}: ${s.text}`);
    expect(bad).toEqual([]);
  });
});
