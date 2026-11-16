import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';
import type { ModelDecisionEventData } from '../../../src/shared/contract/modelDecision';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';
import {
  buildModelDecisionWithToolStrategy,
  buildToolStrategyDiagnostics,
} from '../../../src/host/agent/runtime/contextAssembly/inferenceToolStrategy';

vi.mock('../../../src/host/services', () => ({ getConfigService: vi.fn() }));

const tools: ToolDefinition[] = [{
  name: 'Read',
  description: 'Read a weekly note',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  outputSchema: { type: 'string' },
  requiresPermission: false,
  permissionLevel: 'read',
}];

const decision: ModelDecisionEventData = {
  requestedProvider: 'test',
  requestedModel: 'test-model',
  resolvedProvider: 'test',
  resolvedModel: 'test-model',
  role: null,
  reason: 'user-selected',
  billingMode: 'unknown',
  fallbackFrom: null,
  timestamp: 0,
};

type CopyCase = {
  label: string;
  tools: ToolDefinition[];
  usage?: ModelResponse['usage'];
  status: 'estimated' | 'provider-reported' | 'not-measured';
  wording: string;
  hasUsage: boolean;
};

const cases: CopyCase[] = [
  { label: 'estimated without usage', tools, status: 'estimated', wording: '名称、说明和参数若写进普通对话上下文', hasUsage: false },
  { label: 'estimated with usage', tools, usage: { inputTokens: 500, outputTokens: 50 }, status: 'estimated', wording: '本轮服务商用量已回传：输入 500 / 输出 50 tokens', hasUsage: true },
  { label: 'estimated with zero usage', tools, usage: { inputTokens: 0, outputTokens: 0 }, status: 'estimated', wording: '本轮服务商用量已回传：输入 0 / 输出 0 tokens', hasUsage: true },
  { label: 'provider-reported with usage', tools, usage: { inputTokens: 500, outputTokens: 50, providerReportedSavedTokens: 42 }, status: 'provider-reported', wording: '服务商已回传工具节省量：42 tokens；本轮服务商用量已回传：输入 500 / 输出 50 tokens。', hasUsage: true },
  { label: 'provider-reported without valid usage', tools, usage: { inputTokens: Number.NaN, outputTokens: Number.NaN, providerReportedSavedTokens: 42 }, status: 'provider-reported', wording: '服务商已回传工具节省量：42 tokens；本轮服务商用量未回传。', hasUsage: false },
  { label: 'provider-reported with zero savings and usage', tools, usage: { inputTokens: 0, outputTokens: 0, providerReportedSavedTokens: 0 }, status: 'provider-reported', wording: '服务商已回传工具节省量：0 tokens；本轮服务商用量已回传：输入 0 / 输出 0 tokens。', hasUsage: true },
  { label: 'not-measured with usage', tools: [], usage: { inputTokens: 500, outputTokens: 50 }, status: 'not-measured', wording: '本轮没有可用工具，节省量不计量；本轮服务商用量已回传：输入 500 / 输出 50 tokens。', hasUsage: true },
  { label: 'not-measured without usage', tools: [], status: 'not-measured', wording: '本轮没有可用工具，节省量不计量。', hasUsage: false },
];

describe('tool strategy diagnostic copy through public entries', () => {
  it.each(cases)('$label keeps jargon out of the user-visible detail', ({ label, tools: visibleTools, usage, status, wording, hasUsage }) => {
    const diagnostics = buildToolStrategyDiagnostics(visibleTools, usage);
    const enriched = buildModelDecisionWithToolStrategy(decision, visibleTools, usage);
    const savings = diagnostics.tokenSavings!;

    expect(enriched?.toolStrategy).toEqual(diagnostics);
    expect(savings.status).toBe(status);
    expect(savings.detail).toContain(wording);
    expect(savings.detail).not.toMatch(/provider|usage|saved tokens|token saved|programmatic|inputSchema|name\/description/i);
    expect(savings.measurement?.usageSource).toBe(hasUsage ? 'model-response-usage' : 'unavailable');
    expect(savings.measurement?.providerReportedSavings).toBe(status === 'provider-reported');
    expect(Boolean(savings.providerUsage)).toBe(hasUsage);
    if (status === 'estimated') {
      expect(savings.detail).toContain('真实账单以服务商用量为准。');
      expect(savings.detail).toContain(`约占 ${savings.savedTokens} tokens`);
      expect(savings.basis?.fields).toEqual(['name', 'description', 'inputSchema']);
    }
    process.stdout.write(`${label}: ${savings.detail}\n`);
  });
});
