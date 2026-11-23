// ============================================================================
// modelDecisionProjectionKey - 路由决策去重键（useTurnProjection 消费）
// ============================================================================
// 单独成文件：useTurnProjection.ts 已在行数棘轮上限（>1000 行不许再涨），键构造
// 是纯函数，搬出为主变更腾位。
import type { Message } from '@shared/contract';

type MessageModelDecision = NonNullable<Message['modelDecision']>;

/**
 * 连续相同路由决策的去重键。
 *
 * 键必须对「同一决策」在直播与重放两种形状下取同值：
 * - 直播 `model_decision` 事件在模型调用**前**发射，不带 `toolStrategy`
 *   （宿主调用结束才把工具面诊断并进 runtimeDiagnostics）；
 * - 落库/commit 形状带 `toolStrategy`。
 * 若键含工具面字段，同一轮决策会在 commit 到达瞬间换 key，去重序列被腰斩
 * ——直播期 chip 计数反复膨胀再塌缩，刷新后又与直播期对不上（FB-1682）。
 * 工具面（工具数/MCP/程序化/savings 口径）不是路由语义，不入键。
 *
 * 遥测数值（sampledAt/latency/errorRate）同样不入键——只保留分类态
 * （provider/status），否则同一"用户选择 mimo"决策每轮 key 都不同。
 */
export function buildModelDecisionProjectionKey(decision: MessageModelDecision): string {
  const health = decision.providerHealthSnapshot;
  const providerIdentity = decision.providerIdentity;
  const engine = decision.externalEngine;
  const reliability = engine?.reliability;
  const failure = engine?.failure;

  return JSON.stringify({
    route: [
      decision.reason,
      decision.requestedProvider,
      decision.requestedModel,
      decision.resolvedProvider,
      decision.resolvedModel,
      decision.billingMode,
      decision.fallbackFrom,
    ],
    strategy: [
      decision.strategySummary,
      decision.taskClass,
      decision.costPolicy,
      decision.speedPolicy,
      decision.toolPolicy,
      decision.capabilityNeeds,
    ],
    health: health ? [health.provider, health.status] : null,
    providerIdentity: providerIdentity
      ? [
          providerIdentity.provider,
          providerIdentity.displayName,
          providerIdentity.sourceLabel,
          providerIdentity.protocol,
          providerIdentity.transportLabel,
          providerIdentity.endpoint,
        ]
      : null,
    engine: engine
      ? [
          engine.kind,
          engine.installState,
          engine.runtimeState,
          engine.executable,
          engine.model,
          engine.version,
          engine.capabilities,
          reliability?.cliStatus,
          reliability?.authState,
          reliability?.quotaState,
          reliability?.streamingMode,
          reliability?.toolSupport,
          reliability?.transcriptMode,
          reliability?.partialMessages,
          reliability?.mcpBridge,
          failure?.category,
          failure?.reason,
          failure?.retryable,
          failure?.statusCode,
          failure?.exitCode,
          failure?.reliability?.authState,
          failure?.reliability?.quotaState,
          failure?.reliability?.cliStatus,
        ]
      : null,
  });
}
