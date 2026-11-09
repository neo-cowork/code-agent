import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { toDelegationDisplayToolCall } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ openPreview: vi.fn(), openSettingsTab: vi.fn() }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';

const report = 'Recovery has not been tested.\nPayment failures are not monitored.';
function taskCall(extraOutput = report, name = 'Task'): ToolCall {
  return {
    id: 'risk-review', name, arguments: {},
    result: {
      toolCallId: 'risk-review', success: true,
      output: `Agent [Explorer] completed:\n\n${report}\n\nStats:\n- Iterations: 2`,
      metadata: { artifactRole: 'multiagent-result', result: { output: extraOutput, iterations: 2 } },
    },
  };
}

describe('delegation report display projection', () => {
  it('omits a whitespace-equivalent second report from the display copy, retaining the stored field', () => {
    const call = taskCall('  Recovery has not been tested.\r\n\tPayment failures are not monitored.  ');
    const stored = JSON.stringify(call);
    const visible = toDelegationDisplayToolCall(call);
    expect(visible.result?.metadata?.result).toEqual({ iterations: 2 });
    expect(JSON.stringify(call)).toBe(stored);
    expect(visible.result?.output).toBe(call.result?.output);
    const html = renderToStaticMarkup(<ToolDetails compact toolCall={visible} />);
    expect(html.split('Recovery has not been tested.')).toHaveLength(2);
  });

  it.each([
    'Recovery has not been tested.\nPayment failures ARE monitored.',
    'Recovery has not been tested.',
    '',
  ])('retains genuinely different output: %s', (different) => {
    const call = taskCall(different);
    expect(toDelegationDisplayToolCall(call).result?.metadata?.result).toEqual({ output: different, iterations: 2 });
  });

  it('compares the complete visible output as well as the report inside its envelope', () => {
    const call = taskCall();
    const nested = call.result!.metadata!.result as Record<string, unknown>;
    nested.output = call.result!.output;
    expect(toDelegationDisplayToolCall(call).result?.metadata?.result).toEqual({ iterations: 2 });
  });

  it('handles the spawn_agent task/result envelope without discarding task text from storage', () => {
    const call = taskCall(report, 'spawn_agent');
    call.result!.output = `Agent [Explorer] completed task:\n\nTask: Review notes.\n\nResult:\n${report}\n\nStats:\n- Iterations: 2`;
    const stored = JSON.stringify(call);
    const visible = toDelegationDisplayToolCall(call);
    expect(visible.result?.metadata?.result).toEqual({ iterations: 2 });
    expect(JSON.stringify(call)).toBe(stored);
  });

  it('retains failure metadata when no successful report is displayed', () => {
    const call = taskCall();
    call.result!.success = false;
    call.result!.error = 'Review interrupted';
    expect(toDelegationDisplayToolCall(call).result?.metadata?.result).toEqual({ output: report, iterations: 2 });
  });

  it('compares content even without a decorated Task envelope', () => {
    const call = taskCall(report, 'AgentSpawn');
    call.result!.output = report;
    expect(toDelegationDisplayToolCall(call).result?.metadata?.result).toEqual({ iterations: 2 });
  });
});
