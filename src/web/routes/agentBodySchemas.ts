import { z } from 'zod';
import type { MessageAttachment } from '../../shared/contract/message';
import type { ConversationEnvelopeContext } from '../../shared/contract/conversationEnvelope';
import type { AgentEventFilter } from '../../host/protocol/events/eventFilter';
import { PROMPT_REQUIRED } from '../../shared/contract/agentRunErrors';
import type { TurnEnvironmentSelection } from '../../shared/contract/executionEnvironment';

const LooseObjectSchema = z.object({}).passthrough();

const MessageAttachmentBodySchema = LooseObjectSchema.transform(
  (value) => value as unknown as MessageAttachment,
);

const ConversationEnvelopeContextBodySchema = LooseObjectSchema.transform(
  (value) => value as unknown as ConversationEnvelopeContext,
);

// ADR-081：只声明形状（松 cast，同上两个先例），不在 schema 层校验字段；协议版本
// 是否匹配由 environmentProtocolGate 在解析前判定。值不是对象时 safeParse 失败，
// 这一轮不开始（不静默落回本机）。
const TurnEnvironmentSelectionBodySchema = LooseObjectSchema.transform(
  (value) => value as unknown as TurnEnvironmentSelection,
);

const AgentEventFilterBodySchema = z.object({
  include: z.array(z.string().min(1)).optional(),
  exclude: z.array(z.string().min(1)).optional(),
}).transform((value) => value as AgentEventFilter);

// /goal 自治模式契约。verify / review 至少给一个（设计 §4）：
// - 只给 verify → 硬目标（闸1 确定性验证）
// - 只给 review → 软目标（跳闸1，只走闸2 评审）
// - 都给 → 闸1 通过再走闸2
// 两个都不给 → 无完成判据、永远只能 abort，拒绝启动。
export const GoalBodySchema = z.object({
  goal: z.string().optional(),
  verify: z.string().min(1).optional(),
  review: z.string().min(1).optional(),
  budget: z.number().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  allowSwarm: z.boolean().optional(),
}).refine((g) => !!g.verify || !!g.review, {
  message: 'goal 至少需要 verify 或 review 之一（否则无完成判据，永远无法达成）',
});

export const AgentRunBodySchema = z.object({
  // 空文本只在带附件时放行（只发文件的消息）；纯空白且无附件仍拒绝。
  prompt: z.string(),
  project: z.string().optional(),
  sessionDir: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  eventFilter: AgentEventFilterBodySchema.optional(),
  sessionId: z.string().optional(),
  clientMessageId: z.string().optional(),
  attachments: z.array(MessageAttachmentBodySchema).optional(),
  searchEnabled: z.boolean().optional(),
  thinkingEnabled: z.boolean().optional(),
  effortLevel: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra_code']).optional(),
  context: ConversationEnvelopeContextBodySchema.optional(),
  goal: GoalBodySchema.optional(),
  historyVisibility: z.enum(['visible', 'meta']).optional(),
  disableAutoAgent: z.boolean().optional(),
  environmentSelection: TurnEnvironmentSelectionBodySchema.optional(),
}).passthrough().refine(
  (body) => body.prompt.trim().length > 0 || (body.attachments?.length ?? 0) > 0,
  { path: ['prompt'], message: PROMPT_REQUIRED },
);

/**
 * 判断 /run 校验失败是不是「提示词缺失/为空且没有附件」——用于回稳定码 PROMPT_REQUIRED。
 * prompt 类型错（如数字）等其它字段问题不算，响应保持原样。
 */
export function isPromptRequiredFailure(error: z.ZodError, rawBody: unknown): boolean {
  if (error.issues.some((issue) => issue.path[0] === 'prompt' && issue.code === 'custom')) return true;
  return typeof rawBody === 'object' && rawBody !== null && (rawBody as { prompt?: unknown }).prompt === undefined;
}

export type AgentRunBody = z.infer<typeof AgentRunBodySchema>;

export const AgentCancelBodySchema = z.object({
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  /** 显式「放弃」停靠 run（N-FIX-STOP-BEFORE-FIRST-RESPONSE-STUCK-RUNNING-FU1）：重复 Stop
   *  不带此标记，对 waiting/user_stop 停靠是 no-op，不覆写成 cancelled。 */
  abandonParked: z.boolean().optional(),
}).passthrough();

export const AgentContinueBodySchema = z.object({
  sessionId: z.string().min(1),
}).passthrough();

export const AgentToolResultBodySchema = z.object({
  toolCallId: z.string().min(1),
  success: z.unknown().optional(),
  output: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();
