import type { PermissionRequest, PermissionResponse } from '../../shared/contract/permission';
import type { ToolContext } from '../tools/types';
import { listToolGrants, mintToolSessionGrant } from './toolGrantStore';

const ACTIONS = new Set(['open', 'handle_dialog', 'read_clipboard', 'write_clipboard', 'wait_for_download']);

function origin(value: unknown): string | null {
  try {
    const url = new URL(typeof value === 'string' ? value : '');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch { return null; }
}

/** Drop host-only authority before params can be spread into request details. */
export function stripBrowserGrantFields(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([key]) =>
    !/standingGrant|browser.*(?:grant|crossSite)/i.test(key)));
}

/** undefined = another tool; null target = browser action without remember authority. */
export async function resolveBrowserSessionGrant(
  tool: string, params: Record<string, unknown>, context: ToolContext,
): Promise<PermissionRequest['details']['browserSessionGrant']> {
  if (tool !== 'Browser' && tool !== 'browser_action' && tool !== 'browser_navigate') return undefined;
  const action = String(params.action);
  let site: string | null = null;
  const managed = params.engine === 'managed'
    || (params.engine !== 'relay' && context.executionIntent?.browserSessionMode !== 'desktop');
  if (ACTIONS.has(action) && managed) {
    if (action === 'open') {
      // Only Browser's managed remap executes this action on the managed surface.
      if (tool === 'Browser' && context.executionIntent?.browserSessionMode === 'managed') site = origin(params.url);
    } else if (tool !== 'browser_navigate') {
      try {
        const { getManagedBrowserProviderAdapter, surfaceIdentityFromToolContext } = await import('../services/surfaceExecution/ManagedBrowserProviderAdapter');
        const identity = surfaceIdentityFromToolContext(context);
        const binding = identity ? getManagedBrowserProviderAdapter().getBinding(identity) : null;
        const browser = binding?.browserService;
        const tab = browser?.isRunning() ? browser.getActiveTab() : null;
        if (browser && tab && (!params.tabId || params.tabId === tab.id)) site = origin(browser.getLiveTabUrl(tab.id));
      } catch { /* A failed read never creates a browser or grants authority. */ }
    }
  }
  const target = site ? `${action}@${site}` : null;
  const previousOrigins = target ? [...new Set(listToolGrants().filter((grant) =>
    grant.tier === 'session' && grant.sessionId === context.sessionId && grant.tool === tool
    && grant.target?.startsWith(`${action}@`) && grant.target !== target,
  ).map((grant) => grant.target?.slice(action.length + 1) ?? ''))] : [];
  return { target, previousOrigins };
}

/** Consume only the host-carried string; never resolve a site again while answering. */
export function recordBrowserSessionGrant(response: PermissionResponse, request: PermissionRequest): boolean {
  if (!['Browser', 'browser_action', 'browser_navigate'].includes(request.tool)) return false;
  const target = request.details.browserSessionGrant?.target;
  if (response === 'allow_session' && request.sessionId && target && !request.forceConfirm) {
    mintToolSessionGrant(request.sessionId, request.tool, target);
  }
  return true;
}
