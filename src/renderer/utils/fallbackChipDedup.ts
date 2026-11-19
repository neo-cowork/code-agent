import type { TraceNode } from '@shared/contract/trace';
import { parseModelFallbackNotice } from '../components/features/chat/fallbackNotice';

/**
 * 一次模型降级只该有一条提示。本轮某条 `model_fallback` 横幅的 `from` 与路由 chip 的
 * `decision.fallbackFrom` 指向同一条降级时，chip 是重复提示，返回这些 assistant_text
 * 节点 id 让渲染层隐藏 chip。对不上的（如缺 API key 只发 model_decision、不发横幅，
 * 或同轮另一次降级的横幅）一律保留 chip，它们是各自唯一的提示。外部引擎故障 chip 也保留。
 */
export function getFallbackDuplicateChipNodeIds(nodes: readonly TraceNode[]): ReadonlySet<string> {
  const hidden = new Set<string>();
  const bannerFroms = new Set<string>();
  for (const node of nodes) {
    if (node.subtype !== 'model_fallback') continue;
    const from = parseModelFallbackNotice(node.content)?.from;
    if (from) bannerFroms.add(from);
  }
  if (bannerFroms.size === 0) return hidden;
  for (const node of nodes) {
    const decision = node.modelDecision;
    if (node.type !== 'assistant_text' || !decision) continue;
    if (decision.externalEngine?.failure) continue;
    if (decision.fallbackFrom && bannerFroms.has(decision.fallbackFrom)) hidden.add(node.id);
  }
  return hidden;
}
