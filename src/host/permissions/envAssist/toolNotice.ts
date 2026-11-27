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
import { followRuntimeInstall, holdForRuntimeInstall, isRuntimeNotice, watchOfflineRuntimeCard, runtimeBlockerFor, runtimeModelGuidance, runtimeNoticeFor } from './runtimeNotice';
import { queueNoticeWrite } from './noticeWriteQueue';

/** Both production tool executors pass here before observing or returning a failed result. */
export async function publishEnvAssistToolNotice(input: {
  toolName: string; result: Pick<ToolResult, 'success' | 'error' | 'output' | 'metadata'>; sessionId: string; runId?: string;
  modelResult?: Pick<ToolResult, 'success' | 'error' | 'output' | 'metadata'>;
  parkedToolCallId?: string;
  onEvent: (event: AgentEvent) => void;
  /** The call's own abort signal: a run that waits for a runtime install stops waiting when it fires. */
  signal?: AbortSignal;
}): Promise<void> {
  if (!input.runId) return;
  // A cua denial is attributed to the helper app's identity, so ask the helper (passively) which pane it lacks.
  const cuaTool = parseCuaToolName(input.toolName);
  const cuaPermissions = !input.result.success && cuaTool !== null && cuaTool !== 'check_permissions'
    && classifyCuaFailure(cuaFailureText(input.result)) === 'permission' ? await readCuaHelperPermissionState() : undefined;
  // A runtime Neo installs itself (the shell hook's refusal, or the park it caused) is not a permission: its card
  // follows the install state and never depends on Settings being openable.
  const runtime = runtimeBlockerFor({ toolName: input.toolName, result: input.result, runId: input.runId, parkedToolCallId: input.parkedToolCallId });
  const notice = runtime
    ? runtimeNoticeFor({ sessionId: input.sessionId, runId: input.runId, target: runtime.target, parkedToolCallId: input.parkedToolCallId })
    : classifyEnvBlocker({ ...input, runId: input.runId, cuaPermissions });
  if (!notice) return;
  if (input.parkedToolCallId) notice.parkedToolCallId = input.parkedToolCallId;
  // Diagnostics remain in the connector's host log. Neither events nor model input get the raw error.
  if (!runtime) {
    if (!canOpenEnvSettings()) { notice.phase = 'unsupported'; delete notice.action; }
    // Only Apple-events targets can tell "never asked" from "refused", so only they get the in-place system dialog.
    // Screen recording / accessibility must be toggled in Settings anyway (macOS shows the screen-recording dialog only once ever).
    // Calendar (EventKit) can tell too: undecided shows the dialog, refused opens Settings (calendarGrant.askCalendarFromClick).
    else if (notice.action?.payload && 'pane' in notice.action.payload
      && (notice.action.payload.pane === 'automation' || notice.action.payload.pane === 'calendars') && await canRequestEnvGrant()) {
      notice.action.kind = 'request_grant';
    }
  }
  input.result.error = runtime ? runtimeModelGuidance(notice) : [
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
  await queueNoticeWrite(notice, async () => {
    const manager = getSessionManager();
    const messages = await manager.getMessages(input.sessionId);
    // A card still waiting (for the user, or for an install) is re-pointed instead of joined by a second card.
    const open = isRuntimeNotice(notice) ? ['needs_user', 'fixing'] : ['needs_user'];
    const live = open.includes(notice.phase) ? messages.findLast((m) => {
      const candidate = m.metadata?.envAssist;
      return candidate?.phase !== undefined && open.includes(candidate.phase) && candidate.class === notice.class && candidate.target?.id === notice.target?.id;
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
    await manager.addMessageToSession(input.sessionId, message);
    if (!persisted || (live && notice.id !== computedId)) {
      input.onEvent({ type: 'env_assist_notice', data: notice });
    }
    if (!persisted) input.onEvent({ type: 'message', data: message });
  });
  // The install runs on its own; the card keeps up with it even for a run that cannot wait for it.
  if (runtime) watchOfflineRuntimeCard(notice);
  if (notice.phase === 'fixing') {
    followRuntimeInstall(notice);
    if (runtime && !input.parkedToolCallId) {
      const guidance = await holdForRuntimeInstall(notice, input.signal);
      input.result.error = guidance;
      if (input.modelResult) Object.assign(input.modelResult, { error: guidance });
    }
  }
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
  if (current?.phase !== 'needs_user') return;
  const { action: _action, ...rest } = current;
  const resolved: EnvAssistNotice = { ...rest, phase: 'resolved', doneKey: `env.done.${current.target?.id ?? ''}`, updatedAt: now };
  await manager.addMessageToSession(notice.sessionId, { ...persisted, metadata: { ...persisted.metadata, envAssist: resolved } });
  emitExternalAgentEvent(notice.sessionId, { type: 'env_assist_notice', data: resolved });
}
