// Evidence class: hermetic-protocol (bridge presence stubbed). Not real-device proof.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ present: false }));
vi.mock('../../../../../src/host/permissions/envAssist/shellBridge/client', () => ({ canRequestEnvGrant: () => bridge.present }));
vi.mock('../../../../../src/host/permissions/envAssist/settingsPane', () => ({ canOpenEnvSettings: () => true }));
vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getMessages: async () => [], addMessageToSession: async () => undefined }),
}));

import { publishEnvAssistToolNotice } from '../../../../../src/host/permissions/envAssist/toolNotice';

async function cardActionKind(toolName = 'calendar'): Promise<string | undefined> {
  const metadata = toolName === 'calendar' ? { code: 'not_authorized' } : { failureCause: 'screen_recording_permission' };
  const result = { success: false, error: 'denied', metadata } as never;
  await publishEnvAssistToolNotice({ toolName, result, sessionId: `s-${Math.random()}`, runId: 'r', onEvent: () => undefined });
  return (result as { metadata: { envAssist: { action?: { kind: string } } } }).metadata.envAssist.action?.kind;
}

describe('env-assist card button kind follows the desktop shell bridge', () => {
  beforeEach(() => { bridge.present = false; });
  it('with the shell bridge the button asks macOS directly', async () => {
    bridge.present = true;
    expect(await cardActionKind()).toBe('request_grant');
  });
  it('screen recording keeps opening Settings even with the bridge (macOS prompts for it only once ever)', async () => {
    bridge.present = true;
    expect(await cardActionKind('screenshot')).toBe('open_settings_pane');
  });
  it('without it (web build) the button only opens Settings', async () => {
    expect(await cardActionKind()).toBe('open_settings_pane');
  });
});
