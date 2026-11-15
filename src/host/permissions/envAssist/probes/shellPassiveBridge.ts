/* eslint-disable @typescript-eslint/naming-convention -- Preserve native macOS API names at the PassiveBridge boundary. */
import type { ShellBridgeClient } from '../shellBridge/client';
import type { PassiveBridge } from './types';

interface TrustedResponse {
  trusted: boolean;
}

interface GrantedResponse {
  granted: boolean;
}

interface CodeResponse {
  code: number;
}

export function createShellPassiveBridge(client: ShellBridgeClient): PassiveBridge {
  return {
    async AXIsProcessTrusted(): Promise<boolean> {
      const res = await client.post<TrustedResponse>('/v1/passive/accessibility');
      if (typeof res?.trusted !== 'boolean') {
        throw new Error('env_assist_bridge:invalid_passive_accessibility_response');
      }
      return res.trusted;
    },
    async CGPreflightScreenCaptureAccess(): Promise<boolean> {
      const res = await client.post<GrantedResponse>('/v1/passive/screen');
      if (typeof res?.granted !== 'boolean') {
        throw new Error('env_assist_bridge:invalid_passive_screen_response');
      }
      return res.granted;
    },
    async IOHIDCheckAccess(): Promise<0 | 1 | 2> {
      const res = await client.post<CodeResponse>('/v1/passive/input');
      if (res?.code !== 0 && res?.code !== 1 && res?.code !== 2) {
        throw new Error('env_assist_bridge:invalid_passive_input_response');
      }
      return res.code;
    },
    async AEDeterminePermissionToAutomateTarget(
      targetBundleId: string,
      _askUserIfNeeded: false,
    ): Promise<0 | -1743 | -1744 | -600> {
      const res = await client.post<CodeResponse>('/v1/passive/automation', { targetBundleId });
      if (res?.code !== 0 && res?.code !== -1743 && res?.code !== -1744 && res?.code !== -600) {
        throw new Error('env_assist_bridge:invalid_passive_automation_response');
      }
      return res.code;
    },
    async EKAuthorizationStatusForEvents(): Promise<0 | 1 | 2 | 3 | 4> {
      const res = await client.post<{ status: number }>('/v1/passive/calendar');
      if (res?.status !== 0 && res?.status !== 1 && res?.status !== 2 && res?.status !== 3 && res?.status !== 4) {
        throw new Error('env_assist_bridge:invalid_passive_calendar_response');
      }
      return res.status;
    },
  };
}
