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
  it('prefers the exact run surface and fails closed (no legacy fallback) once the surface is gone', () => {
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
    expect(resolveBrowserGrantActiveUrl(context)).toBeUndefined();

    rememberBrowserGrantSurface(identity, surface);
    forgetBrowserGrantSurfacesForConversation(identity.conversationId);
    expect(resolveBrowserGrantActiveUrl(context)).toBeUndefined();

    // Callers with no managed-run identity still use the legacy pool source.
    expect(resolveBrowserGrantActiveUrl({ agentId: identity.agentId })).toBe('https://legacy.example/form');
    forgetLegacyBrowserGrantSource(identity.agentId);
    expect(resolveBrowserGrantActiveUrl({ agentId: identity.agentId })).toBeUndefined();
  });
});
