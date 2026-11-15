// English-UI GPT-1 / NanoGPT teaching copy: the demo payload stays Chinese on purpose
// (see labI18nRatchet.test.ts), but every Chinese quote in the English blocks must carry
// an adjacent English gloss, and glossary cards must not print Chinese.
import { describe, it, expect } from 'vitest';
import { labGpt1En } from '../../../src/renderer/i18n/labGpt1';
import { labNanogptEn } from '../../../src/renderer/i18n/labNanogpt';

const CJK = /[぀-ヿ㐀-鿿]/;

function walk(node: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof node === 'string') {
    out.push([path, node]);
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, out));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, out);
  }
}

function strings(root: unknown, name: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  walk(root, name, out);
  return out;
}

const ALLOW: Record<string, string> = {
  'labGpt1En.labGpt1.tokenizerStage.whyExample': 'demo IDs for Chinese characters, glossed inline',
  'labGpt1En.labGpt1.tokenizerStage.ruleCommonDesc': 'Chinese word example, glossed inline',
  'labGpt1En.labGpt1.tokenizerStage.demoStep1Example': 'Chinese sample sentence, translated inline',
  'labGpt1En.labGpt1.tokenizerStage.encodeExampleFrom': 'Chinese demo token, glossed inline',
  'labGpt1En.labGpt1.tokenizerStage.decodeExampleTo': 'Chinese demo token, glossed inline',
  'labGpt1En.labGpt1.modelArchitecture.layers.attention.description': 'Chinese disambiguation example, glossed inline',
  'labGpt1En.labGpt1.modelArchitecture.workflowStep1Desc': 'Chinese demo token, glossed inline',
  'labGpt1En.labGpt1.modelArchitecture.workflowStep2Desc': 'Chinese demo tokens, glossed inline',
  'labGpt1En.labGpt1.modelArchitecture.workflowStep4Desc': 'Chinese demo token, glossed inline',
  'labGpt1En.labGpt1.inferenceTest.howStep1': 'Chinese demo greeting, glossed inline',
  'labGpt1En.labGpt1.inferenceTest.howStep2': 'Chinese candidate characters, glossed inline',
  'labGpt1En.labGpt1.inferenceTest.howStep3': 'Chinese candidate character, glossed inline',
  'labGpt1En.labGpt1.inferenceTest.processYouSay': 'Chinese demo greeting, glossed inline',
  'labGpt1En.labGpt1.inferenceTest.processCandidates': 'Chinese candidate characters, glossed inline',
  'labGpt1En.labGpt1.inferenceTest.chatSamplesNote': 'Chinese quick-reply samples, translated inline with reply gist',
  'labGpt1En.labGpt1.inferenceTest.processResult': 'Chinese demo reply, glossed inline',
  'labNanogptEn.labNanogpt.tokenizer.inputNote': 'Chinese sample sentence, translated inline',
};

describe('English lab teaching copy (GPT-1 / NanoGPT)', () => {
  const all = [...strings(labGpt1En, 'labGpt1En'), ...strings(labNanogptEn, 'labNanogptEn')];
  const cjk = all.filter(([, v]) => CJK.test(v));
  const isGlossaryZh = ([p]: [string, string]) => /\.terms\[\d+\]\.zh$/.test(p);

  it('glossary terms carry no Chinese name', () => {
    const zhs = all.filter(isGlossaryZh);
    expect(zhs.length).toBeGreaterThan(20);
    expect(zhs.filter(([, v]) => v !== '')).toEqual([]);
  });

  it('every CJK string is allow-listed and keeps an English gloss', () => {
    const paths = cjk.map(([p]) => p);
    expect(paths.filter((p) => !(p in ALLOW))).toEqual([]);
    expect(Object.keys(ALLOW).filter((p) => !paths.includes(p))).toEqual([]);
    const unglossed = cjk.filter(([, v]) => {
      const rest = v.replace(/[^\sA-Za-z]*[぀-ヿ㐀-鿿][^\sA-Za-z]*/g, ' ');
      return (rest.match(/[A-Za-z]{2,}/g) ?? []).length < 2;
    });
    expect(unglossed.map(([p]) => p)).toEqual([]);
  });
});
