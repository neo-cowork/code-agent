import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../../../src/host/protocol/tools';
import { AgentFailureCode } from '../../../../../src/shared/contract/agentFailure';
import { taskModule } from '../../../../../src/host/tools/modules/multiagent/task';

describe('Task readonly parent topology (real module, no executor mock)', () => {
  it('refuses an explore caller dispatching coder with a plain reason', async () => {
    const handler = await taskModule.createHandler();
    const ctx = {
      abortSignal: new AbortController().signal,
      subagent: { agentRole: 'explore' },
    } as ToolContext;
    const result = await handler.execute(
      { prompt: 'Count TypeScript files with a script', subagent_type: 'coder' },
      ctx,
      async () => ({ allow: true }),
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'PERMISSION_DENIED',
      error: "PERMISSION_DENIED: readonly parent role 'explore' cannot spawn writer child role 'coder'. Switch to default mode or spawn a non-writer agent.",
      meta: {
        cancellationReason: 'child-refusal',
        failureRouting: 'surface',
        failureCode: AgentFailureCode.BlockedByParentRole,
      },
    });
  });
});
