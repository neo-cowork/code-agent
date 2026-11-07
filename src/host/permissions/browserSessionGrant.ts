// ============================================================================
// 托管浏览器外部副作用动作的「本次会话允许」授权（N-FIX-BROWSER-DOOMLOOP-REAPPROVE-FU1-SESSION）
// ============================================================================
// 按 (sessionId, catalog action, site origin) 存储在进程内 Map。
// 站点 origin 一律由 host 解析，绝不采信模型在参数里自报的说明文字：
//   - open：从参数里的 http(s) url 解析 origin
//   - handle_dialog / read_clipboard / write_clipboard / wait_for_download：
//     从 browserService.getActiveTab() 的活动标签页 URL 解析 origin
//   - execute_goal / upload_file / 系统浏览器标签动作（nav_back/nav_forward/refresh/
//     close_window/newTab/switchTab）及未注册或无法解析 origin 的情况一律返回 null（永不铸权、逐次询问）。
// ============================================================================

import { getStrictBrowserComputerActionCatalogForArgs, normalizeBrowserComputerCatalogToolName } from '../../shared/utils/browserComputerActionCatalog';
import type { ToolContext } from '../tools/types';
import { getBrowserService } from '../services/infra/browserPool';
import { getManagedBrowserProviderAdapter, surfaceIdentityFromToolContext } from '../services/surfaceExecution/ManagedBrowserProviderAdapter';

const GRANTABLE_BROWSER_ACTIONS = new Set([
  'handle_dialog',
  'read_clipboard',
  'write_clipboard',
  'wait_for_download',
  'open',
]);

interface BrowserGrantScope {
  action: string;
  origin: string;
}

interface StoredBrowserSessionGrant {
  action: string;
  origin: string;
  grantedAt: number;
}

interface BrowserSessionGrantItem {
  sessionId: string;
  scopeKey: string;
  action: string;
  origin: string;
  grantedAt: number;
}

const sessions = new Map<string, Map<string, StoredBrowserSessionGrant>>();

function parseHttpOrigin(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.origin || parsed.origin === 'null') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function buildScopeKey(scope: BrowserGrantScope): string {
  return `${scope.action}@${scope.origin}`;
}

export function resolveBrowserGrantScope(
  toolName: unknown,
  params: Record<string, unknown> | undefined,
  browserContext?: ToolContext,
): BrowserGrantScope | null {
  const catalogTool = normalizeBrowserComputerCatalogToolName(toolName);
  if (catalogTool !== 'browser_action') return null;
  const entry = getStrictBrowserComputerActionCatalogForArgs({
    toolName: catalogTool,
    arguments: params,
  });
  if (!entry || !GRANTABLE_BROWSER_ACTIONS.has(entry.action)) return null;

  let rawUrl = params?.url;
  if (entry.action !== 'open') {
    const surfaceIdentity = browserContext
      ? surfaceIdentityFromToolContext(browserContext)
      : null;
    const service = surfaceIdentity
      ? getManagedBrowserProviderAdapter().getBrowserService(surfaceIdentity)
      : getBrowserService(browserContext?.agentId);
    rawUrl = service.getActiveTab()?.url;
  }
  const origin = parseHttpOrigin(rawUrl);
  if (!origin) return null;

  return {
    action: entry.action,
    origin,
  };
}

export function readBrowserGrantScopeFromPermissionDetails(
  toolName: unknown,
  details: Record<string, unknown> | undefined,
): BrowserGrantScope | null {
  const catalogTool = normalizeBrowserComputerCatalogToolName(toolName);
  if (catalogTool !== 'browser_action') return null;
  const entry = getStrictBrowserComputerActionCatalogForArgs({
    toolName: catalogTool,
    arguments: details,
  });
  const rawScope = details?.browserGrantScope;
  if (
    !entry
    || !GRANTABLE_BROWSER_ACTIONS.has(entry.action)
    || !rawScope
    || typeof rawScope !== 'object'
    || Array.isArray(rawScope)
  ) return null;
  const scope = rawScope as Record<string, unknown>;
  if (scope.action !== entry.action) return null;
  const origin = parseHttpOrigin(scope.origin);
  return origin ? { action: entry.action, origin } : null;
}

export function mintBrowserSessionGrant(
  sessionId: string,
  scope: BrowserGrantScope,
  grantedAt = Date.now(),
): void {
  if (!sessionId || !GRANTABLE_BROWSER_ACTIONS.has(scope.action)) return;
  const origin = parseHttpOrigin(scope.origin);
  if (!origin) return;
  const normalized: BrowserGrantScope = { action: scope.action, origin };
  let bucket = sessions.get(sessionId);
  if (!bucket) {
    bucket = new Map();
    sessions.set(sessionId, bucket);
  }
  bucket.set(buildScopeKey(normalized), {
    action: normalized.action,
    origin: normalized.origin,
    grantedAt,
  });
}

export function matchBrowserSessionGrant(
  sessionId: string | undefined,
  scope: BrowserGrantScope | null | undefined,
): string | null {
  if (!sessionId || !scope || !GRANTABLE_BROWSER_ACTIONS.has(scope.action)) return null;
  const origin = parseHttpOrigin(scope.origin);
  if (!origin) return null;
  const key = buildScopeKey({ action: scope.action, origin });
  if (!sessions.get(sessionId)?.has(key)) return null;
  return `browser_grant:${key}`;
}

export function formatBrowserCrossSiteReason(
  sessionId: string | undefined,
  scope: BrowserGrantScope | null | undefined,
): string | null {
  if (!sessionId || !scope) return null;
  const bucket = sessions.get(sessionId);
  if (!bucket) return null;
  const allowedOrigins: string[] = [];
  for (const stored of bucket.values()) {
    if (stored.action === scope.action && stored.origin !== scope.origin && !allowedOrigins.includes(stored.origin)) {
      allowedOrigins.push(stored.origin);
    }
  }
  if (allowedOrigins.length === 0) return null;
  return `本会话此前仅允许在 ${allowedOrigins.join('、')} 执行 ${scope.action}，当前站点为 ${scope.origin}，需重新确认`;
}

export function listBrowserSessionGrants(sessionId?: string): BrowserSessionGrantItem[] {
  const items: BrowserSessionGrantItem[] = [];
  for (const [sid, bucket] of sessions) {
    if (sessionId !== undefined && sid !== sessionId) continue;
    for (const [scopeKey, stored] of bucket) {
      items.push({
        sessionId: sid,
        scopeKey,
        action: stored.action,
        origin: stored.origin,
        grantedAt: stored.grantedAt,
      });
    }
  }
  return items;
}

export function clearBrowserSessionGrants(sessionId?: string): void {
  if (sessionId === undefined) {
    sessions.clear();
    return;
  }
  sessions.delete(sessionId);
}

export function revokeBrowserSessionGrant(sessionId: string, scopeKey: string): boolean {
  return sessions.get(sessionId)?.delete(scopeKey) ?? false;
}
