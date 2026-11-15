import type { Translations } from '../i18n/zh';

type EngineManifestCopy = Translations['engineManifest'];
interface EngineRecommendation { label: string; reason: string }

/**
 * 执行引擎简介的唯一显示出口：按清单 id 取语言包里的写法；
 * 语言包没收录的（比如刚加进清单还没补文案）退回清单/宿主给的原文。
 */
export function getEngineSummary(
  source: { manifestId: string; summary: string },
  copy: EngineManifestCopy,
): string {
  const summaries: Record<string, string | undefined> = copy.summaries;
  return summaries[source.manifestId] ?? source.summary;
}

/** 执行引擎推荐语（角标 + 理由）的唯一显示出口，取法同上。 */
export function getEngineRecommendation(
  source: { manifestId: string; recommendation?: EngineRecommendation },
  copy: EngineManifestCopy,
): EngineRecommendation | undefined {
  const recommendations: Record<string, EngineRecommendation | undefined> = copy.recommendations;
  return recommendations[source.manifestId] ?? source.recommendation;
}
