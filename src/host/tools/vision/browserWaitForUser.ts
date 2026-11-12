// wait_for_user — N-BROWSER-WAIT-FOR-USER-RESUME-W2
//
// 模型显式声明「这一步需要用户亲自在浏览器里做（验证码 / 登录 / 支付确认）」：
// 把浏览器交给用户（takeover），页面保持可操作，阻塞到用户按「好了」。
// 阻塞期间按人工等待记账（beginApprovalWait），不被 120s 工具无进展预算和 run 级预算计时。
// 超时不停会话、不关窗：返回 WAIT_FOR_USER_TIMEOUT，让模型用一句大白话收尾。

import type { ToolContext, ToolExecutionResult } from '../types';
import { getBrowserWaitForUserLimitMs } from '../../../shared/constants/timeouts';
import { getPermissionModeManager } from '../../permissions/modes';
import { beginApprovalWait, endApprovalWait } from '../toolExecutionTelemetry';
import {
  getManagedBrowserProviderAdapter,
  isUserBrowserSurfaceIdentity,
  type ManagedBrowserProviderAdapter,
} from '../../services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  getSurfaceExecutionRuntime,
  type SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../services/surfaceExecution/SurfaceExecutionRuntime';
import {
  BROWSER_HUMAN_TOUCHED_NOTE,
  consumeBrowserHumanTouched,
} from '../../services/surfaceExecution/browserHumanTakeoverWait';

const REASON_MAX_CHARS = 120;
// 面向用户的一句话：不许是网址、路径、工具名（snake_case 标识符）或反引号代码。
const REASON_FORBIDDEN = /https?:\/\/|www\.|`|\\|(?:^|\s)~?\/[\w.-]|\b[a-z0-9]+_[a-z0-9_]+\b/i;

export interface WaitForUserInput {
  identity: SurfaceRuntimeIdentityV1 | null;
  context: Pick<ToolContext, 'sessionId' | 'currentToolCallId'>;
  params: Record<string, unknown>;
  adapter?: Pick<ManagedBrowserProviderAdapter, 'getBinding'>;
  runtime?: Pick<SurfaceExecutionRuntime, 'control'>;
}

function refuse(error: string, code: string): ToolExecutionResult {
  return { success: false, error, metadata: { code } };
}

/** Returns the cleaned reason, or an error sentence for the model. */
function validateReason(raw: unknown): { reason: string } | { error: string } {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (!reason) {
    return { error: 'wait_for_user needs a "reason": one plain sentence, in the user\'s language, saying what the user should do in the browser.' };
  }
  if (reason.length > REASON_MAX_CHARS) {
    return { error: `The "reason" is too long (${reason.length} characters). Use one plain sentence of at most ${REASON_MAX_CHARS} characters.` };
  }
  if (REASON_FORBIDDEN.test(reason)) {
    return { error: 'The "reason" is shown to the user as-is. Write one plain sentence without web addresses, file paths, tool names or code.' };
  }
  return { reason };
}

export async function executeWaitForUser(input: WaitForUserInput): Promise<ToolExecutionResult> {
  const checked = validateReason(input.params.reason);
  if ('error' in checked) return refuse(checked.error, 'WAIT_FOR_USER_REASON_INVALID');
  const { reason } = checked;

  if (input.params.engine === 'relay') {
    return refuse('wait_for_user is not available for the relay engine; the user already has that Chrome tab in front of them. Tell the user in chat what they need to do, then stop and wait for their reply.', 'WAIT_FOR_USER_UNAVAILABLE');
  }
  const sessionId = input.context.sessionId;
  if (sessionId && getPermissionModeManager().isUnattendedSession(sessionId)) {
    return refuse('wait_for_user is not available for unattended or scheduled runs; no one is there to help. Finish with what you have and tell the user what is blocked.', 'WAIT_FOR_USER_UNAVAILABLE');
  }
  if (!input.identity || isUserBrowserSurfaceIdentity(input.identity)) {
    return refuse('wait_for_user needs a browser session opened by this run.', 'WAIT_FOR_USER_UNAVAILABLE');
  }
  const binding = (input.adapter ?? getManagedBrowserProviderAdapter()).getBinding(input.identity);
  if (!binding) {
    return refuse('No browser session is open for this run. Open the page with browser_action first, then call wait_for_user.', 'WAIT_FOR_USER_UNAVAILABLE');
  }

  const subject = {
    sessionId: binding.surfaceSessionId,
    runId: binding.identity.runId,
    agentId: binding.identity.agentId,
  };
  const runtime = input.runtime ?? getSurfaceExecutionRuntime();
  let pending;
  try {
    pending = await runtime.control(subject, 'takeover', {
      reason,
      timeoutMs: getBrowserWaitForUserLimitMs(),
      waitForUser: true,
    });
  } catch (error) {
    return refuse(`The browser could not be handed to the user (${error instanceof Error ? error.message : String(error)}). Tell the user in chat what they need to do, then stop and wait for their reply.`, 'WAIT_FOR_USER_UNAVAILABLE');
  }
  if (!pending) {
    return refuse('The browser could not be handed to the user. Tell the user in chat what they need to do, then stop and wait for their reply.', 'WAIT_FOR_USER_UNAVAILABLE');
  }

  // 人工等待记账：120s 工具无进展预算与 run 级预算都扣掉这段时间。
  beginApprovalWait(input.context.currentToolCallId, sessionId);
  let resolution;
  try {
    resolution = await pending.wait;
  } finally {
    endApprovalWait(input.context.currentToolCallId, sessionId);
  }

  if (resolution === 'continue' || resolution === 'navigated') {
    consumeBrowserHumanTouched(binding.surfaceSessionId);
    return {
      success: true,
      output: 'The user says they finished. The page may have changed. Call get_dom_snapshot to re-read it before you act, then continue the task.',
      metadata: { waitForUser: { outcome: 'done' } },
    };
  }
  if (resolution === 'timed_out') {
    return {
      success: false,
      error: 'The user did not respond in time. The browser window stays open on the same page and nothing was closed. Do not call browser actions again now. End this turn with one plain sentence telling the user what is waiting for them; they can finish it in the window and tell you to continue.',
      metadata: { code: 'WAIT_FOR_USER_TIMEOUT', userActionRequired: true, recoverable: true },
    };
  }
  return refuse('The user stopped the browser session instead of finishing. Stop working on the browser and tell the user in one plain sentence where things stand.', 'WAIT_FOR_USER_CANCELLED');
}

/**
 * 用户在任何接管之后交还浏览器：该 session 的第一条浏览器动作结果带一句「有人动过页面」提示。
 * 成功写进 output 开头，失败写进 error 开头（失败结果也是模型下一步依据）。
 */
export function applyHumanTouchedNote(
  result: ToolExecutionResult,
  surfaceSessionId: string | undefined,
): ToolExecutionResult {
  if (!surfaceSessionId || !consumeBrowserHumanTouched(surfaceSessionId)) return result;
  if (result.success) {
    return { ...result, output: `${BROWSER_HUMAN_TOUCHED_NOTE}\n\n${result.output ?? ''}`.trimEnd() };
  }
  return { ...result, error: `${BROWSER_HUMAN_TOUCHED_NOTE}\n\n${result.error ?? ''}`.trimEnd() };
}
