import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEB_SERVER_CONNECTION_MONITOR as timing } from '../../../src/shared/constants';

// Exercise real domain HTTP transport → createSession → toast, not a synthetic error mapping.
describe('createSession during a network outage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    vi.stubGlobal('window', { location: { origin: 'http://localhost:8180', search: '', reload: vi.fn() } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each(['zh', 'en'] as const)('%s: human toast before and after the banner, HTTP business errors retained', async (language) => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    vi.stubGlobal('fetch', fetchMock);
    const { createHttpDomainAPI } = await import('../../../src/renderer/api/httpTransport');
    const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    const { useAppStore } = await import('../../../src/renderer/stores/appStore');
    const { useToastStore } = await import('../../../src/renderer/hooks/useToast');
    const { useServerConnectionStore } = await import('../../../src/renderer/stores/serverConnectionStore');
    const { getServerReconnectingMessage } = await import('../../../src/renderer/utils/serverConnectionMonitor');
    window.domainAPI = createHttpDomainAPI('http://localhost:8180');
    useAppStore.setState({ language });
    useSessionStore.setState({ sessions: [], currentSessionId: null });

    for (const status of ['ok', 'recovering']) {
      expect(useServerConnectionStore.getState().status).toBe(status);
      expect(await useSessionStore.getState().createSession('Weekly report')).toBeNull();
      const toast = useToastStore.getState().toasts.at(-1)?.message;
      expect(toast).toContain(getServerReconnectingMessage());
      expect(toast).not.toMatch(/Load failed|TypeError/);
      expect(useSessionStore.getState().error).toBe(getServerReconnectingMessage());
      await vi.advanceTimersByTimeAsync(timing.PROBE_INTERVAL_MS);
    }
    for (const status of [400, 500]) {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'Business failure' } }), { status }));
      expect(await useSessionStore.getState().createSession('Weekly report')).toBeNull();
      expect(useToastStore.getState().toasts.at(-1)?.message).toContain('Business failure');
    }
  });
});
