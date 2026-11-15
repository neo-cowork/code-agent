// Evidence class: hermetic-protocol (bridge presence stubbed). Not real-device proof.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ present: false }));
vi.mock('../../../../../src/host/permissions/envAssist/shellBridge/client', () => ({ canRequestEnvGrant: () => bridge.present }));
vi.mock('../../../../../src/host/permissions/envAssist/settingsPane', () => ({ canOpenEnvSettings: () => true }));
vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getMessages: async () => [], addMessageToSession: async () => undefined }),
}));

import { publishEnvAssistToolNotice } from '../../../../../src/host/permissions/envAssist/toolNotice';

async function cardActionKind(): Promise<string | undefined> {
  const result = { success: false, error: 'denied', metadata: { code: 'not_authorized' } } as never;
  await publishEnvAssistToolNotice({ toolName: 'calendar', result, sessionId: `s-${Math.random()}`, runId: 'r', onEvent: () => undefined });
  return (result as { metadata: { envAssist: { action?: { kind: string } } } }).metadata.envAssist.action?.kind;
}

describe('env-assist card button kind follows the desktop shell bridge', () => {
  beforeEach(() => { bridge.present = false; });
  it('with the shell bridge the button asks macOS directly', async () => {
    bridge.present = true;
    expect(await cardActionKind()).toBe('request_grant');
  });
  it('without it (web build) the button only opens Settings', async () => {
    expect(await cardActionKind()).toBe('open_settings_pane');
  });
});
