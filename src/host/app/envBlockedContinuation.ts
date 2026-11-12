import type { Message } from '../../shared/contract';
import type { RunRegistry } from '../runtime/runRegistry';
import { NativeRecoveryHost, isNativeRecoveryDescriptor, type NativeRecoveryHostPorts } from '../runtime/nativeRecoveryHost';
import { createApplicationNativeRecoveryPorts } from './nativeRecoveryHost';
import type { TaskManager } from '../task';
import { ToolExecutor } from '../tools/toolExecutor';

/** Reuse native recovery's evidence lookup, replay classification and write interruption. */
export async function continueEnvBlockedRun(input: {
  runId: string;
  registry: RunRegistry;
  tasks: Pick<TaskManager, 'resumeExistingDurableRun'>;
  getMessages: (sessionId: string) => Promise<Message[]>;
  ports?: NativeRecoveryHostPorts;
}): Promise<void> {
  const { registry, runId } = input;
  const plan = await registry.getDurableRehydrationPlan(runId);
  const descriptor = plan.checkpoint?.state;
  if (!isNativeRecoveryDescriptor(descriptor)) throw new Error('Environment continuation descriptor is unavailable');
  const ports = input.ports ?? createApplicationNativeRecoveryPorts(registry, {
    tasks: input.tasks,
    executeTool: async (tool) => {
      const handle = registry.bindRecoveredHandle(plan, descriptor.workspace.root, descriptor.workspace.cwd);
      try {
        // NativeRecoveryHost admits only automatic read-only replay here. A changed
        // permission requirement is denied rather than inferring fresh consent.
        const executor = new ToolExecutor({
          requestPermission: async () => false,
          workingDirectory: handle.context.cwd, runContext: handle.context,
        });
        return await executor.execute(tool.name, tool.arguments, {
          runId, sessionId: tool.sessionId, sourceMessageId: tool.sourceMessageId,
          currentToolCallId: tool.toolCallId, turnId: tool.toolCallId,
        });
      } finally { registry.unregister(runId, handle); }
    },
  });
  // Read history through the same source as manual Continue (web/desktop parity).
  const base = ports.continueLoop;
  const recoveryPorts: NativeRecoveryHostPorts = {
    ...ports,
    continueLoop: async (operation) => {
      if (input.ports && base) { await base(operation); return; }
      const messages = await input.getMessages(plan.envelope.sessionId);
      const source = messages.find((message) => message.id === descriptor.sourceMessageId && message.role === 'user');
      if (!source) throw new Error('Environment continuation source message is unavailable');
      await input.tasks.resumeExistingDurableRun(plan.envelope.sessionId, runId, messages,
        { mode: 'normal', disableAutoAgent: true }, source.metadata, source.id);
    },
  };
  if (plan.pendingOperations.every((operation) => ['succeeded', 'failed', 'abandoned'].includes(operation.status))) {
    const operation = plan.pendingOperations.find((candidate) => candidate.operationId === descriptor.operationId);
    if (!operation) throw new Error('Environment continuation operation is unavailable');
    const continueLoop = recoveryPorts.continueLoop;
    if (!continueLoop) throw new Error('Environment continuation loop is unavailable');
    await continueLoop({ plan, descriptor, operation });
    return;
  }
  const result = await new NativeRecoveryHost(registry, recoveryPorts).createHandler().recover(plan, Date.now());
  if (result.status !== 'recovered') throw new Error(`Environment continuation stopped: ${result.reason}`);
}
