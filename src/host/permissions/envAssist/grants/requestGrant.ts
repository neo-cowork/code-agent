import { ENV_ASSIST_CLICK_TTL_MS } from '../../../../shared/constants/envAssist';
import type { PromptingBridge } from '../probes/types';

const clickBrand: unique symbol = Symbol('EnvAssistClick');
interface ClickToken {
  readonly [clickBrand]: true;
  readonly noticeId: string;
  readonly issuedAt: number;
}
const pending = new WeakSet<ClickToken>();

type GrantTarget = { pane: 'accessibility' | 'screenCapture' | 'inputMonitoring' | 'automation'; targetBundleId?: string };

/** Called only after the IPC user action has matched the current owned notice. */
export function mintClickToken(noticeId: string, now: () => number = Date.now): ClickToken {
  const token: ClickToken = Object.freeze({ [clickBrand]: true as const, noticeId, issuedAt: now() });
  pending.add(token);
  return token;
}

export async function requestGrant(token: ClickToken, target: GrantTarget, bridge: PromptingBridge | null, now: () => number = Date.now): Promise<'requested' | 'rejected' | 'not_available'> {
  if (!token || !pending.delete(token)) return 'rejected';
  const age = now() - token.issuedAt;
  if (!Number.isFinite(age) || age < 0 || age >= ENV_ASSIST_CLICK_TTL_MS) return 'rejected';
  if (!bridge) return 'not_available';
  switch (target.pane) {
    case 'accessibility': await bridge.requestAccessibility(); break;
    case 'screenCapture': await bridge.CGRequestScreenCaptureAccess(); break;
    case 'inputMonitoring': await bridge.IOHIDRequestAccess(); break;
    case 'automation':
      if (!target.targetBundleId) return 'rejected';
      await bridge.AEDeterminePermissionToAutomateTarget(target.targetBundleId, true);
      break;
  }
  return 'requested';
}
