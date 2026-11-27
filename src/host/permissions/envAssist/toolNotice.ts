import { randomUUID } from 'node:crypto';
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

// Serialize publishes and resolutions for the same permission across runs.
const pending = new Map<string, Promise<void>>();

async function queueNoticeWrite(notice: EnvAssistNotice, write: () => Promise<void>): Promise<void> {
  const key = JSON.stringify([notice.sessionId, notice.class, notice.target?.id]);
  const previous = pending.get(key);
  const operation = (async () => {
    if (previous) await previous.catch(() => undefined);
    await write();
  })();
  pending.set(key, operation);
  try { await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
}

/** Both production tool executors pass here before observing or returning a failed result. */
export async function publishEnvAssistToolNotice(input: {
  toolName: string; result: Pick<ToolResult, 'success' | 'error' | 'output' | 'metadata'>; sessionId: string; runId?: string;
  modelResult?: Pick<ToolResult, 'success' | 'error' | 'output' | 'metadata'>;
  parkedToolCallId?: string;
  onEvent: (event: AgentEvent) => void;
}): Promise<void> {
  if (!input.runId) return;
  // A cua denial is attributed to the helper app's identity, so ask the helper (passively) which pane it lacks.
  const cuaTool = parseCuaToolName(input.toolName);
  const cuaPermissions = !input.result.success && cuaTool !== null && cuaTool !== 'check_permissions'
    && classifyCuaFailure(cuaFailureText(input.result)) === 'permission' ? await readCuaHelperPermissionState() : undefined;
  const notice = classifyEnvBlocker({ ...input, runId: input.runId, cuaPermissions });
  if (!notice) return;
  if (input.parkedToolCallId) notice.parkedToolCallId = input.parkedToolCallId;
  // Diagnostics remain in the connector's host log. Neither events nor model input get the raw error.
  if (!canOpenEnvSettings()) { notice.phase = 'unsupported'; delete notice.action; }
  // Only Apple-events targets can tell "never asked" from "refused", so only they get the in-place system dialog.
  // Screen recording / accessibility must be toggled in Settings anyway (macOS shows the screen-recording dialog only once ever).
  // Calendar (EventKit) can tell too: undecided shows the dialog, refused opens Settings (calendarGrant.askCalendarFromClick).
  else if (notice.action?.payload && 'pane' in notice.action.payload
    && (notice.action.payload.pane === 'automation' || notice.action.payload.pane === 'calendars') && await canRequestEnvGrant()) {
    notice.action.kind = 'request_grant';
  }
  input.result.error = [
    'Model guidance (not user copy): A permission card has already been shown to the user.',
    'Do not repeat or quote this guidance, error text, tool names, commands, or internal status labels, including in a delegated summary.',
    // Only runs that cannot park reach this text (a parked calendar run never shows it to the model), and nothing
    // resumes them: the honest follow-up is asking again. The card closes itself once granted.
    notice.action
      ? "The card has an allow button. In one short sentence in the user's language, tell them to allow it with that button on the card and then ask again. Do not claim you will check or continue on your own. Do not suggest a different authorization route."
      : "The card has no button because opening settings is unavailable here. In one short sentence in the user's language, explain that permission must be granted on the desktop and then ask again. Do not claim a button is available.",
  ].join(' ');
  input.result.output = undefined;
  input.result.metadata = { envAssist: notice };
  if (input.modelResult) Object.assign(input.modelResult, { error: input.result.error, output: undefined, metadata: input.result.metadata });
  await publishEnvAssistNotice(notice, input.onEvent);
}

export async function publishEnvAssistNotice(notice: EnvAssistNotice, onEvent: (event: AgentEvent) => void): Promise<void> {
  await queueNoticeWrite(notice, async () => {
    const manager = getSessionManager();
    const messages = await manager.getMessages(notice.sessionId);
    const live = (notice.phase === 'needs_user' || notice.class === 'offline') ? messages.findLast((m) => {
      const candidate = m.metadata?.envAssist;
      return candidate?.phase === notice.phase && candidate.class === notice.class && candidate.target?.id === notice.target?.id
        && (notice.class !== 'offline' || candidate.runId === notice.runId);
    }) : undefined;
    let persisted = live ?? messages.find((m) => m.id === `env-assist:${notice.id}`);
    const computedId = notice.id;
    if (live?.metadata?.envAssist) {
      notice.id = live.metadata.envAssist.id;
    } else if (persisted?.metadata?.envAssist?.phase === 'resolved') {
      // A resumed run can lose access again. Keep its resolved history and leave the target as the ID suffix.
      notice.id = `${notice.runId}|${notice.class}|${randomUUID()}|${notice.target?.id ?? ''}`;
      persisted = undefined;
    }
    const messageId = `env-assist:${notice.id}`;
    const message: Message = {
      id: messageId, role: 'assistant', content: '', timestamp: persisted?.timestamp ?? notice.updatedAt,
      metadata: { ...persisted?.metadata, envAssist: notice },
    };
    await manager.addMessageToSession(notice.sessionId, message);
    if (!persisted || notice.class === 'offline' || (live && notice.id !== computedId)) {
      onEvent({ type: 'env_assist_notice', data: notice });
    }
    if (!persisted) onEvent({ type: 'message', data: message });
  });
}

/** Once a probe reads granted: the card's persisted copy becomes "done" (survives reload) and open windows update live. */
export async function resolveEnvAssistNotice(notice: EnvAssistNotice, now = Date.now()): Promise<void> {
  await queueNoticeWrite(notice, () => writeResolved(notice, now));
}

async function writeResolved(notice: EnvAssistNotice, now: number): Promise<void> {
  const manager = getSessionManager();
  const messageId = `env-assist:${notice.id}`;
  const persisted = (await manager.getMessages(notice.sessionId)).find((m) => m.id === messageId);
  if (!persisted) return;
  const current = persisted.metadata?.envAssist;
  if (!current || (current.class === 'offline' ? current.phase !== 'fixing' : current.phase !== 'needs_user')) return;
  const { action: _action, ...rest } = current;
  const resolved: EnvAssistNotice = { ...rest, phase: 'resolved', doneKey: current.class === 'offline' ? 'env.offline.resolved' : `env.done.${current.target?.id ?? ''}`, updatedAt: now };
  await manager.addMessageToSession(notice.sessionId, { ...persisted, metadata: { ...persisted.metadata, envAssist: resolved } });
  emitExternalAgentEvent(notice.sessionId, { type: 'env_assist_notice', data: resolved });
}
