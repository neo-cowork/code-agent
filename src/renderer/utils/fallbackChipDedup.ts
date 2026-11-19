import type { TraceNode } from '@shared/contract/trace';

/**
 * 一次模型降级只该有一条提示。本轮已有 `model_fallback` 横幅时，仅因降级而存在的
 * 路由 chip（fallbackFrom / fallback-availability 且无外部引擎故障）是重复提示，
 * 返回这些 assistant_text 节点 id 让渲染层隐藏 chip。没有横幅（如目标 provider 缺
 * API key，只发 model_decision）时返回空集合，chip 是唯一提示，必须保留。
 */
export function getFallbackDuplicateChipNodeIds(nodes: readonly TraceNode[]): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (!nodes.some((node) => node.subtype === 'model_fallback')) return hidden;
  for (const node of nodes) {
    const decision = node.modelDecision;
    if (node.type !== 'assistant_text' || !decision) continue;
    if (decision.externalEngine?.failure) continue;
    if (decision.fallbackFrom || decision.reason === 'fallback-availability') hidden.add(node.id);
  }
  return hidden;
}
