import type { AgentEvent, Message, ToolResult } from '../../../shared/contract';
import { getSessionManager } from '../../services/infra/sessionManager';
import { classifyEnvBlocker } from './classify';
import { canOpenEnvSettings } from './settingsPane';

// In-flight reservations close the parent/delegate race; persisted ids survive reloads.
const pending = new Map<string, Promise<void>>();

/** Both production tool executors pass here before observing or returning a failed result. */
export async function publishEnvAssistToolNotice(input: {
  toolName: string; result: Pick<ToolResult, 'success' | 'error' | 'output' | 'metadata'>; sessionId: string; runId?: string;
  modelResult?: Pick<ToolResult, 'success' | 'error' | 'output' | 'metadata'>;
  onEvent: (event: AgentEvent) => void;
}): Promise<void> {
  if (!input.runId) return;
  const notice = classifyEnvBlocker({ ...input, runId: input.runId });
  if (!notice) return;
  // Diagnostics remain in the connector's host log. Neither events nor model input get the raw error.
  input.result.error = 'Permission is needed to continue.';
  input.result.output = undefined;
  input.result.metadata = { envAssist: notice };
  if (input.modelResult) Object.assign(input.modelResult, { error: input.result.error, output: undefined, metadata: input.result.metadata });
  if (!canOpenEnvSettings()) { notice.phase = 'unsupported'; delete notice.action; }
  const key = `${input.sessionId}|${notice.id}`;
  const previous = pending.get(key);
  const persist = async () => {
    if (previous) await previous;
    const manager = getSessionManager();
    const messageId = `env-assist:${notice.id}`;
    const persisted = (await manager.getMessages(input.sessionId)).find((m) => m.id === messageId);
    const message: Message = {
      id: messageId, role: 'assistant', content: '', timestamp: persisted?.timestamp ?? notice.updatedAt,
      metadata: { ...persisted?.metadata, envAssist: notice },
    };
    await manager.addMessageToSession(input.sessionId, message);
    if (persisted) return;
    input.onEvent({ type: 'env_assist_notice', data: notice });
    input.onEvent({ type: 'message', data: message });
  };
  const operation = persist();
  pending.set(key, operation);
  try { await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
}
