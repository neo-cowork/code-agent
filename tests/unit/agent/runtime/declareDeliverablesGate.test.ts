import { describe, expect, it, vi } from 'vitest';
import {
  applyDeclareDeliverablesOutcome,
  recordDeclareDeliverables,
} from '../../../../src/host/agent/runtime/declareDeliverablesGate';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import type { ToolCall, ToolResult } from '../../../../src/shared/contract';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';

function makeCtx(overrides: Partial<RuntimeContext> = {}) {
  return {
    workingDirectory: '/tmp/workspace',
    sessionId: 's1',
    turnTrace: { record: vi.fn() },
    artifact: ArtifactState.forTest(),
    ...overrides,
  } as unknown as RuntimeContext;
}

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `tc-${name}`, name, arguments: args };
}

describe('recordDeclareDeliverables', () => {
  it('returns null and leaves ctx unchanged when no declare_deliverables call exists', () => {
    const ctx = makeCtx();
    expect(recordDeclareDeliverables(ctx, [toolCall('Read', { file_path: 'README.md' })])).toBeNull();
    expect(ctx.artifact.declaredDeliverables).toBeUndefined();
  });

  it('valid call records the declaration and returns confirmation text (no early exit signal)', () => {
    const ctx = makeCtx();
    const outcomes = recordDeclareDeliverables(ctx, [
      toolCall('declare_deliverables', { final_artifacts: ['dist/index.html'], scratch_dir: 'draft' }),
      toolCall('WebSearch', { query: 'x' }),
    ]);
    expect(ctx.artifact.declaredDeliverables?.finalArtifacts).toEqual(['dist/index.html']);
    expect(ctx.artifact.declaredDeliverables?.scratchDir).toBe('draft');
    expect(outcomes?.size).toBe(1);
    const outcome = outcomes?.get('tc-declare_deliverables');
    expect(outcome?.success).toBe(true);
    expect(outcome?.text).toContain('已记录最终产物声明');
    expect(outcome?.text).toContain('dist/index.html');
    expect(outcome?.text).toContain('draft');
  });

  it('second valid call overrides the previous declaration and says so', () => {
    const ctx = makeCtx({
      artifact: ArtifactState.forTest({
        declaredDeliverables: { finalArtifacts: ['old/game.html'], scratchDir: 'old-draft', declaredAtMs: 1 },
      }),
    });
    const outcomes = recordDeclareDeliverables(ctx, [
      toolCall('declare_deliverables', { final_artifacts: ['new/index.html'], scratch_dir: 'new-draft' }),
    ]);
    expect(ctx.artifact.declaredDeliverables?.finalArtifacts).toEqual(['new/index.html']);
    const text = outcomes?.get('tc-declare_deliverables')?.text ?? '';
    expect(text).toContain('已覆盖之前的声明');
    expect(text).toContain('old/game.html');
    expect(text).toContain('new/index.html');
  });

  it.each([
    ['missing final_artifacts', {}],
    ['empty final_artifacts', { final_artifacts: [] }],
  ])('invalid call (%s) does not mutate ctx and yields a failed outcome with the reason', (_label, args) => {
    const previous = { finalArtifacts: ['existing/final.html'], scratchDir: 'scratch', declaredAtMs: 123 };
    const ctx = makeCtx({ artifact: ArtifactState.forTest({ declaredDeliverables: previous }) });
    const outcome = recordDeclareDeliverables(ctx, [toolCall('declare_deliverables', args)])
      ?.get('tc-declare_deliverables');
    expect(ctx.artifact.declaredDeliverables).toBe(previous);
    expect(outcome?.success).toBe(false);
    expect(outcome?.text).toContain('declare_deliverables 声明已拒绝');
    expect(outcome?.text).toContain('final_artifacts');
  });
});

describe('applyDeclareDeliverablesOutcome', () => {
  it('overwrites only the declare result and leaves other results untouched', () => {
    const results: ToolResult[] = [
      { toolCallId: 'a', success: true, output: 'executor fallback' },
      { toolCallId: 'b', success: true, output: 'search hits' },
    ];
    applyDeclareDeliverablesOutcome(results, new Map([['a', { success: false, text: 'rejected' }]]));
    expect(results[0]).toMatchObject({ success: false, error: 'rejected' });
    expect(results[0].output).toBeUndefined();
    expect(results[1]).toMatchObject({ success: true, output: 'search hits' });
  });

  it('does not rewrite a result that already failed before the executor ran', () => {
    const results: ToolResult[] = [{ toolCallId: 'a', success: false, error: 'blocked by hook' }];
    applyDeclareDeliverablesOutcome(results, new Map([['a', { success: true, text: 'ok' }]]));
    expect(results[0]).toMatchObject({ success: false, error: 'blocked by hook' });
  });
});
