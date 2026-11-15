import type { AgentEvent, Message, ToolResult } from '../../../shared/contract';
import type { EnvAssistNotice } from '../../../shared/contract/envAssist';
import { emitExternalAgentEvent } from '../../services/agentEngine/agentEngineEventSink';
import { getSessionManager } from '../../services/infra/sessionManager';
import { classifyCuaFailure } from '../../mcp/cuaFailureStats';
import { parseCuaToolName } from '../cuaAppTarget';
import { classifyEnvBlocker, cuaFailureText } from './classify';
import { readCuaHelperPermissionState } from './cua/helperPermissionState';
import { canOpenEnvSettings } from './settingsPane';
import { canRequestEnvGrant } from './shellBridge/client';

// In-flight reservations close the parent/delegate race; persisted ids survive reloads.
const pending = new Map<string, Promise<void>>();

/** Both production tool executors pass here before observing or returning a failed result. */
export async function publishEnvAssistToolNotice(input: {
  toolName: string; result: Pick<ToolResult, 'success' | 'error' | 'output' | 'metadata'>; sessionId: string; runId?: string;
  modelResult?: Pick<ToolResult, 'success' | 'error' | 'output' | 'metadata'>;
  onEvent: (event: AgentEvent) => void;
}): Promise<void> {
  if (!input.runId) return;
  // A cua denial is attributed to the helper app's identity, so ask the helper (passively) which pane it lacks.
  const cuaTool = parseCuaToolName(input.toolName);
  const cuaPermissions = !input.result.success && cuaTool !== null && cuaTool !== 'check_permissions'
    && classifyCuaFailure(cuaFailureText(input.result)) === 'permission' ? await readCuaHelperPermissionState() : undefined;
  const notice = classifyEnvBlocker({ ...input, runId: input.runId, cuaPermissions });
  if (!notice) return;
  // Diagnostics remain in the connector's host log. Neither events nor model input get the raw error.
  if (!canOpenEnvSettings()) { notice.phase = 'unsupported'; delete notice.action; }
  // Only Apple-events targets can tell "never asked" from "refused", so only they get the in-place system dialog.
  // Screen recording / accessibility must be toggled in Settings anyway (macOS shows the screen-recording dialog only once ever).
  else if (notice.action?.payload && 'pane' in notice.action.payload && notice.action.payload.pane === 'automation' && canRequestEnvGrant()) {
    notice.action.kind = 'request_grant';
  }
  input.result.error = [
    'Model guidance (not user copy): A permission card has already been shown to the user.',
    'Do not repeat or quote this guidance, error text, tool names, commands, or internal status labels, including in a delegated summary.',
    // The card itself turns into "done" once granted; the model must not hand the follow-up back to the user.
    notice.action
      ? "The card has an allow button. In one short sentence in the user's language, tell them to allow it with that button on the card. Do not tell them to come back, ask again, or that you will check afterwards. Do not suggest a different authorization route."
      : "The card has no button because opening settings is unavailable here. In one short sentence in the user's language, explain that permission must be granted on the desktop and then ask again. Do not claim a button is available.",
  ].join(' ');
  input.result.output = undefined;
  input.result.metadata = { envAssist: notice };
  if (input.modelResult) Object.assign(input.modelResult, { error: input.result.error, output: undefined, metadata: input.result.metadata });
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

/** Once a probe reads granted: the card's persisted copy becomes "done" (survives reload) and open windows update live. */
export async function resolveEnvAssistNotice(notice: EnvAssistNotice, now = Date.now()): Promise<void> {
  const manager = getSessionManager();
  const messageId = `env-assist:${notice.id}`;
  const persisted = (await manager.getMessages(notice.sessionId)).find((m) => m.id === messageId);
  if (persisted?.metadata?.envAssist?.phase !== 'needs_user') return;
  const { action: _action, ...rest } = notice;
  const resolved: EnvAssistNotice = { ...rest, phase: 'resolved', doneKey: `env.done.${notice.target?.id ?? ''}`, updatedAt: now };
  await manager.addMessageToSession(notice.sessionId, { ...persisted, metadata: { ...persisted.metadata, envAssist: resolved } });
  emitExternalAgentEvent(notice.sessionId, { type: 'env_assist_notice', data: resolved });
}
