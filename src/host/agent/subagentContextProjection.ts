import type { ToolCall } from '../../shared/contract';
import type { ContextInterventionSnapshot } from '../../shared/contract/contextView';
import { ACTIVE_TOOL_RESULT_PRUNE } from '../../shared/constants';
import {
  CompressionPipeline,
  DEFAULT_COMPRESSION_PIPELINE_ENABLED,
  getCompressionPipelineOverride,
} from '../context/compressionPipeline';
import { CompressionState } from '../context/compressionState';
import { resolveToolResultBudget } from '../context/layers/toolResultBudget';
import type { ProjectableMessage } from '../context/projectionEngine';
import { estimateTokens } from '../context/tokenEstimator';
import { resolveTriggerTokens } from '../context/triggerTokens';
import { resolveContextWindow, resolveModelMaxOutputTokens } from '../model/modelLimits';
import { createLogger } from '../services/infra/logger';
import { flattenMessageContent, type RuntimeMessage } from './subagentExecutorProjection';

const logger = createLogger('SubagentContextProjection');

/** Per-run adapter; only the shared pipeline owns compression policy. */
export class SubagentContextProjection {
  private readonly pipeline = new CompressionPipeline();
  private readonly state = new CompressionState();
  private readonly results = new Map<string, Array<{ call: ToolCall; content: string }>>();

  constructor(
    private readonly model: string,
    private readonly provider: string | undefined,
    private readonly sessionId: string,
  ) {}

  // Capture boundaries before joining. Tool output may itself contain any of
  // the flattened envelope's separators, status lines, or tool names.
  recordToolResults(message: RuntimeMessage, calls: ToolCall[], results: string[]): void {
    this.results.set(message.id, results.map((content, index) => ({ call: calls[index], content })));
  }

  async project(
    messages: RuntimeMessage[],
    iteration: number,
    interventions: ContextInterventionSnapshot,
  ): Promise<RuntimeMessage[]> {
    const copies = structuredClone(messages);
    const protectedIds = new Set([...(interventions.pinned ?? []), ...(interventions.retained ?? [])]);
    const transcript: ProjectableMessage[] = [];
    const resultIds = new Map<string, string[]>();
    let turnIndex = 0;
    for (const message of copies) {
      if (message.role === 'assistant') turnIndex++;
      const parts = this.results.get(message.id);
      if (parts) {
        const ids = parts.map(({ call, content }) => {
          const id = `${message.id}:${call.id}`;
          if (protectedIds.has(message.id)) protectedIds.add(id);
          transcript.push({ id, role: 'tool', content, toolCallId: call.id, toolName: call.name, turnIndex });
          return id;
        });
        resultIds.set(message.id, ids);
      } else {
        transcript.push({ ...message, content: flattenMessageContent(message.content), turnIndex });
      }
    }

    const maxTokens = resolveContextWindow(this.model, this.provider);
    const budget = resolveToolResultBudget(maxTokens);
    const enabled = getCompressionPipelineOverride() ?? DEFAULT_COMPRESSION_PIPELINE_ENABLED;
    const beforeTokens = transcript.reduce((sum, message) => sum + 4 + estimateTokens(message.content), 3);
    const result = await this.pipeline.evaluate(transcript, this.state, {
      maxTokens,
      model: this.model,
      provider: this.provider,
      currentTurnIndex: turnIndex,
      isMainThread: false,
      cacheHot: false,
      idleMinutes: 0,
      enableSnip: enabled,
      enableMicrocompact: enabled,
      // No background summarizer, including the optional Jev L4 branch.
      enableContextCollapse: false,
      toolResultBudget: budget.l1MaxTokens,
      activeToolResultPrune: {
        enabled: enabled && ACTIVE_TOOL_RESULT_PRUNE.ENABLED,
        maxTokensPerResult: budget.l0MaxTokens,
        spillSessionId: this.sessionId,
      },
      protectedToolResultPredicate: (message) => protectedIds.has(message.id),
      spillSessionId: this.sessionId,
      autocompactTriggerTokens: resolveTriggerTokens(
        maxTokens, undefined, resolveModelMaxOutputTokens(this.model, this.provider),
      ),
    });
    if (result.layersTriggered.length > 0) {
      logger.info(`[SubagentContextProjection] session=${this.sessionId} round=${iteration} layers=${result.layersTriggered.join(',')} tokens=${beforeTokens}->${result.totalTokens}`);
    }

    const apiById = new Map(result.apiView.map((message) => [message.id, message]));
    const projectedContent = (id: string): string => {
      const message = apiById.get(id);
      if (!message) throw new Error('SUBAGENT_CONTEXT_PROJECTION_MISSING_MESSAGE');
      return message.content;
    };
    return copies.map((message) => {
      const ids = resultIds.get(message.id);
      if (ids) {
        message.content = `Tool results:\n${ids.map(projectedContent).join('\n\n')}`;
      } else if (typeof message.content === 'string') {
        message.content = projectedContent(message.id);
      }
      return message;
    });
  }
}
