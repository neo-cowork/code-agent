import { describe, expect, it } from 'vitest';
import { languages } from '../../../src/renderer/i18n';
import { getEngineRecommendation, getEngineSummary } from '../../../src/renderer/utils/engineManifestCopy';
import { listExternalEngineManifests } from '../../../src/shared/externalEngineManifest';

const HAN = /[㐀-䶿一-鿿豈-﫿]/u;
const manifests = listExternalEngineManifests();

describe('执行引擎清单的简介与推荐语跟随界面语言（FB-1294）', () => {
  it('清单里每个引擎：中文与清单原文逐字相同，英文有且不含中文', () => {
    expect(manifests.length).toBeGreaterThan(0);
    for (const manifest of manifests) {
      const source = { manifestId: manifest.id, summary: manifest.summary, recommendation: manifest.recommendation };
      expect(getEngineSummary(source, languages.zh.engineManifest)).toBe(manifest.summary);
      expect(getEngineRecommendation(source, languages.zh.engineManifest)).toEqual(manifest.recommendation);

      const enSummary = getEngineSummary(source, languages.en.engineManifest);
      expect(enSummary, manifest.id).not.toBe(manifest.summary);
      expect(enSummary, manifest.id).not.toMatch(HAN);
      const enRecommendation = getEngineRecommendation(source, languages.en.engineManifest);
      expect(Boolean(enRecommendation)).toBe(Boolean(manifest.recommendation));
      if (enRecommendation) expect(`${enRecommendation.label}${enRecommendation.reason}`, manifest.id).not.toMatch(HAN);
    }
  });

  it('语言包里没有清单已经不存在的条目', () => {
    const ids = new Set(manifests.map((manifest) => manifest.id));
    const recommended = new Set(manifests.filter((manifest) => manifest.recommendation).map((manifest) => manifest.id));
    for (const pack of [languages.zh.engineManifest, languages.en.engineManifest]) {
      expect(Object.keys(pack.summaries).filter((id) => !ids.has(id))).toEqual([]);
      expect(Object.keys(pack.recommendations).filter((id) => !recommended.has(id))).toEqual([]);
    }
  });

  it('清单新增而语言包还没收录的引擎，退回显示来源给的原文', () => {
    const source = { manifestId: 'brand_new_engine', summary: 'source text', recommendation: { label: 'L', reason: 'R' } };
    expect(getEngineSummary(source, languages.en.engineManifest)).toBe('source text');
    expect(getEngineRecommendation(source, languages.en.engineManifest)).toEqual({ label: 'L', reason: 'R' });
  });
});
