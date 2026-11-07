// Lightweight bridge from Browser service ownership to permission scope resolution.
// Keep this module free of BrowserService runtime imports: ToolExecutor is imported by
// many permission tests whose platform mocks intentionally do not initialize a browser.

interface BrowserActiveTabSource {
  getActiveTab(): { url?: unknown } | null;
}

interface BrowserSurfaceIdentity {
  conversationId: string;
  runId: string;
  agentId: string;
}

interface BrowserGrantContext {
  sessionId?: string;
  runId?: string;
  agentId?: string;
}

const DEFAULT_AGENT_KEY = '__default__';
const surfaceSources = new Map<string, WeakRef<BrowserActiveTabSource>>();
const legacySources = new Map<string, WeakRef<BrowserActiveTabSource>>();

function surfaceKey(identity: BrowserSurfaceIdentity): string {
  return `${identity.conversationId}\u0000${identity.runId}\u0000${identity.agentId}`;
}

function identityFromContext(context: BrowserGrantContext | undefined): BrowserSurfaceIdentity | null {
  const conversationId = context?.sessionId?.trim();
  const runId = context?.runId?.trim();
  const agentId = context?.agentId?.trim();
  return conversationId && runId && agentId ? { conversationId, runId, agentId } : null;
}

export function rememberBrowserGrantSurface(
  identity: BrowserSurfaceIdentity,
  source: BrowserActiveTabSource,
): void {
  surfaceSources.set(surfaceKey(identity), new WeakRef(source));
}

export function forgetBrowserGrantSurface(identity: BrowserSurfaceIdentity): void {
  surfaceSources.delete(surfaceKey(identity));
}

export function forgetBrowserGrantSurfacesForConversation(conversationId: string): void {
  const prefix = `${conversationId}\u0000`;
  for (const key of surfaceSources.keys()) {
    if (key.startsWith(prefix)) surfaceSources.delete(key);
  }
}

export function rememberLegacyBrowserGrantSource(
  agentId: string | null | undefined,
  source: BrowserActiveTabSource,
): void {
  legacySources.set(agentId || DEFAULT_AGENT_KEY, new WeakRef(source));
}

export function forgetLegacyBrowserGrantSource(agentId: string): void {
  legacySources.delete(agentId);
}

export function resolveBrowserGrantActiveUrl(context?: BrowserGrantContext): unknown {
  const identity = identityFromContext(context);
  const surfaceSource = identity ? surfaceSources.get(surfaceKey(identity))?.deref() : undefined;
  if (surfaceSource) return surfaceSource.getActiveTab()?.url;

  const legacyKey = context?.agentId?.trim() || DEFAULT_AGENT_KEY;
  const legacySource = legacySources.get(legacyKey)?.deref();
  return legacySource?.getActiveTab()?.url;
}
