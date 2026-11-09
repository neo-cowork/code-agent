import { describe, expect, it, vi } from 'vitest';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/host/protocol/tools';
import { ToolRegistry } from '../../../../../src/host/tools/registry';
import { registerMigratedTools } from '../../../../../src/host/tools/modules';
import { stashDeclareOutcome } from '../../../../../src/host/tools/modules/planning/declareDeliverablesOutcomeStore';
import { declareDeliverablesModule } from '../../../../../src/host/tools/modules/planning/declareDeliverables';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('declareDeliverablesModule', () => {
  it('has the expected planning schema metadata', () => {
    expect(declareDeliverablesModule.schema.name).toBe('declare_deliverables');
    expect(declareDeliverablesModule.schema.category).toBe('planning');
    expect(declareDeliverablesModule.schema.permissionLevel).toBe('read');
    expect(declareDeliverablesModule.schema.readOnly).toBe(true);
    expect(declareDeliverablesModule.schema.allowInPlanMode).toBe(false);
    expect(declareDeliverablesModule.schema.inputSchema.required).toContain('final_artifacts');
  });

  it('is visible through migrated tool registration', async () => {
    const registry = new ToolRegistry();
    registerMigratedTools(registry, 'win32');

    expect(registry.has('declare_deliverables')).toBe(true);
    const handler = await registry.resolve('declare_deliverables');
    expect(handler.schema.name).toBe('declare_deliverables');
    expect(handler.schema.category).toBe('planning');
  });

  it('executor returns the recorded outcome handed over by the runtime gate (no internal jargon)', async () => {
    const handler = await declareDeliverablesModule.createHandler();
    stashDeclareOutcome('test-session', 'call-ok', { success: true, text: '已记录最终产物声明。' });
    stashDeclareOutcome('test-session', 'call-bad', { success: false, text: '声明已拒绝：final_artifacts 不能为空' });

    const ok = await handler.execute({}, makeCtx({ currentToolCallId: 'call-ok' }), allowAll);
    const bad = await handler.execute({}, makeCtx({ currentToolCallId: 'call-bad' }), allowAll);

    expect(ok).toEqual({ ok: true, output: '已记录最终产物声明。' });
    expect(bad).toEqual({ ok: false, error: '声明已拒绝：final_artifacts 不能为空' });
  });

  it('without a recorded outcome it still answers in plain language', async () => {
    const handler = await declareDeliverablesModule.createHandler();
    const result = await handler.execute({ final_artifacts: ['a.md'] }, makeCtx({ currentToolCallId: 'none' }), allowAll);
    expect(result).toEqual({ ok: true, output: '已收到最终产物声明。' });
  });
});
