import { describe, expect, it } from 'vitest';
import {
  forgetBrowserGrantSurface,
  forgetBrowserGrantSurfacesForConversation,
  forgetLegacyBrowserGrantSource,
  rememberBrowserGrantSurface,
  rememberLegacyBrowserGrantSource,
  resolveBrowserGrantActiveUrl,
} from '../../../src/host/services/infra/browserGrantActiveUrlRegistry';

describe('browserGrantActiveUrlRegistry', () => {
  it('prefers the exact run surface and falls back to the legacy agent service after cleanup', () => {
    const identity = {
      conversationId: 'registry-session',
      runId: 'registry-run',
      agentId: 'registry-agent',
    };
    const context = {
      sessionId: identity.conversationId,
      runId: identity.runId,
      agentId: identity.agentId,
    };
    const surface = { getActiveTab: () => ({ url: 'https://surface.example/form' }) };
    const legacy = { getActiveTab: () => ({ url: 'https://legacy.example/form' }) };

    rememberLegacyBrowserGrantSource(identity.agentId, legacy);
    rememberBrowserGrantSurface(identity, surface);
    expect(resolveBrowserGrantActiveUrl(context)).toBe('https://surface.example/form');

    forgetBrowserGrantSurface(identity);
    expect(resolveBrowserGrantActiveUrl(context)).toBe('https://legacy.example/form');

    rememberBrowserGrantSurface(identity, surface);
    forgetBrowserGrantSurfacesForConversation(identity.conversationId);
    expect(resolveBrowserGrantActiveUrl(context)).toBe('https://legacy.example/form');

    forgetLegacyBrowserGrantSource(identity.agentId);
    expect(resolveBrowserGrantActiveUrl(context)).toBeUndefined();
  });
});
