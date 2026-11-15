/* eslint-disable @typescript-eslint/naming-convention -- Preserve native macOS API names at the PromptingBridge boundary. */
import type { PromptingBridge } from '../probes/types';
import type { ShellBridgeClient } from '../shellBridge/client';

interface RequestedResponse {
  requested: boolean;
}

export function createShellPromptingBridge(client: ShellBridgeClient): PromptingBridge {
  return {
    async requestAccessibility(): Promise<void> {
      const res = await client.post<RequestedResponse>('/v1/grant/accessibility');
      if (res?.requested !== true) {
        throw new Error('env_assist_bridge:invalid_grant_accessibility_response');
      }
    },
    async CGRequestScreenCaptureAccess(): Promise<void> {
      const res = await client.post<RequestedResponse>('/v1/grant/screen');
      if (res?.requested !== true) {
        throw new Error('env_assist_bridge:invalid_grant_screen_response');
      }
    },
    async IOHIDRequestAccess(): Promise<void> {
      const res = await client.post<RequestedResponse>('/v1/grant/input');
      if (res?.requested !== true) {
        throw new Error('env_assist_bridge:invalid_grant_input_response');
      }
    },
    async AEDeterminePermissionToAutomateTarget(
      targetBundleId: string,
      _askUserIfNeeded: true,
    ): Promise<void> {
      const res = await client.post<RequestedResponse>('/v1/grant/automation', { targetBundleId });
      if (res?.requested !== true) {
        throw new Error('env_assist_bridge:invalid_grant_automation_response');
      }
    },
  };
}
