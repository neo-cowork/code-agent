// English-UI LLaMA-Factory / Alignment teaching copy: sample data lives in the dictionaries (not in TSX),
// the English blocks carry no unexplained Chinese, and the zh blocks keep the original Chinese samples.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { labLlamafactoryEn, labLlamafactoryZh } from '../../../src/renderer/i18n/labLlamafactory';
import { labAlignmentEn, labAlignmentZh } from '../../../src/renderer/i18n/labAlignment';
import oldZh from './labSampleZhOld.fixture.json';

const CJK = /[぀-ヿ㐀-鿿]/;

function walk(node: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof node === 'string') out.push([path, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, out);
  }
}
function strings(root: unknown, name: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  walk(root, name, out);
  return out;
}

// LLaMA-Factory dataset-format JSON samples stay Chinese (they are data); each carries an English gloss in `exampleGloss`.
const ALLOW: Record<string, string> = {
  'labLlamafactoryEn.labLlamafactory.sft.dataFormats.alpaca.exampleLines': 'Alpaca JSON sample, glossed in exampleGloss',
  'labLlamafactoryEn.labLlamafactory.sft.dataFormats.sharegpt.exampleLines': 'ShareGPT JSON sample, glossed in exampleGloss',
  'labLlamafactoryEn.labLlamafactory.sft.dataFormats.openai.exampleLines': 'OpenAI-format JSON sample, glossed in exampleGloss',
};

describe('English lab teaching copy (LLaMA-Factory / Alignment)', () => {
  const all = [...strings(labLlamafactoryEn, 'labLlamafactoryEn'), ...strings(labAlignmentEn, 'labAlignmentEn')];
  const cjk = all
    .filter(([, v]) => CJK.test(v))
    .map(([p, v]) => [p.replace(/\[\d+\]$/, ''), v] as [string, string]);

  it('every CJK string is allow-listed and keeps an English gloss', () => {
    const paths = [...new Set(cjk.map(([p]) => p))];
    expect(paths.filter((p) => !(p in ALLOW))).toEqual([]);
    expect(Object.keys(ALLOW).filter((p) => !paths.includes(p))).toEqual([]);
    const f = labLlamafactoryEn.labLlamafactory.sft.dataFormats;
    for (const fmt of [f.alpaca, f.sharegpt, f.openai]) {
      expect(fmt.exampleGloss).toMatch(/[A-Za-z]{3,}.*[A-Za-z]{3,}/);
      expect(CJK.test(fmt.exampleGloss)).toBe(false);
    }
  });

  it('glossary cards never print Chinese or a duplicated word in English', () => {
    const terms = all.filter(([p]) => /\.glossaryTerms\[\d+\]\.(zh|meaning)$/.test(p));
    expect(terms.length).toBeGreaterThan(20);
    expect(terms.filter(([, v]) => CJK.test(v))).toEqual([]);
  });
});

describe('Chinese UI unchanged: zh dictionary samples equal the old TSX literals', () => {
  const a = labAlignmentZh.labAlignment;
  const l = labLlamafactoryZh.labLlamafactory;
  it('alignment samples', () => {
    expect(a.comparison.examples).toEqual(oldZh.comparisonExamples);
    expect(a.reward.preferenceExamples).toEqual(oldZh.preferenceExamples);
    expect(a.sft.instructionExamples).toEqual(oldZh.instructionExamples);
    expect(a.sft.beforeAfterExamples).toEqual(oldZh.beforeAfterExamples);
  });
  it('llamafactory samples', () => {
    expect(l.preference.chosenRejectedExample).toEqual(oldZh.preferenceExample);
    expect(l.preference.comparisonExample).toEqual(oldZh.comparisonExampleData);
    expect(l.rlhf.rftQuestion).toBe(oldZh.rftQuestion);
    expect(l.sft.dataFormats.alpaca.exampleLines.join('\n')).toBe(oldZh.dataFormatExamples.alpaca);
    expect(l.sft.dataFormats.sharegpt.exampleLines.join('\n')).toBe(oldZh.dataFormatExamples.sharegpt);
    expect(l.sft.dataFormats.openai.exampleLines.join('\n')).toBe(oldZh.dataFormatExamples.openai);
  });
});

describe('lab TSX files hold no CJK outside comments', () => {
  const LAB = join(__dirname, '../../../src/renderer/components/features/lab');
  const files = [
    'alignment/stages/AlignmentComparison.tsx',
    'alignment/stages/RewardModelStage.tsx',
    'alignment/stages/SFTStage.tsx',
    'llamafactory/stages/PreferenceStage.tsx',
    'llamafactory/stages/SFTStage.tsx',
    'llamafactory/stages/RLHFStage.tsx',
  ];
  it.each(files)('%s', (rel) => {
    const offenders = readFileSync(join(LAB, rel), 'utf8')
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => CJK.test(line) && !/^(\/\/|\*|\/\*|\{\/\*)/.test(line))
      .map(({ n, line }) => `${n}: ${line}`);
    expect(offenders).toEqual([]);
  });
});
