import type { BrowserService } from '../infra/browserService';
import { browserPool } from '../infra/browserPool';
import type { ToolExecutionResult } from '../../tools/types';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../shared/contract/surfaceExecution';
import type { BrowserLastPageStore } from './browserLastPageStore';
import type { KeptBrowserRegistry } from './keptBrowserRegistry';

/** The Surface session ends; only its physical window survives the handover. */
export async function releaseManagedBrowserWindow(input: {
  binding: {
    identity: { conversationId: string; agentId?: string };
    serviceKey: string;
    browserService: BrowserService;
  };
  stillShared: boolean;
  parkForTakeover: boolean;
  personalServiceKey: string;
  keptRegistry: KeptBrowserRegistry;
  releaseBrowser(serviceKey: string): Promise<void>;
  lastPageStore?: BrowserLastPageStore;
  onLastPageRecordError?(error: unknown): void;
}): Promise<void> {
  const { binding, stillShared, keptRegistry } = input;
  const { browserService, serviceKey, identity } = binding;
  const activeTab = browserService.getActiveTab();
  if (
    input.lastPageStore
    && identity.agentId !== SURFACE_USER_BROWSER_AGENT_ID
    && serviceKey !== input.personalServiceKey
  ) {
    try {
      await input.lastPageStore.recordForConversation(identity.conversationId, activeTab?.url);
    } catch (error) {
      input.onLastPageRecordError?.(error);
    }
  }
  // wait_for_user already parked this exact window on its timeout (parkedForUser slot):
  // re-parking it as a takeover would flip its reason and attach the sign-in handoff
  // note to the reclaiming run, which wait_for_user's own wording covers. Skip; the
  // existing entry stays authoritative.
  const alreadyParked = [keptRegistry.get(identity.conversationId), keptRegistry.getParkedAlive(identity.conversationId)]
    .some((entry) => entry?.serviceKey === serviceKey && entry.state === 'kept');
  // Record the park even if the panel currently has a user binding to this window.
  // Explicit Stop and timeout do not set parkForTakeover; only endRun does.
  if (input.parkForTakeover && !alreadyParked && serviceKey !== input.personalServiceKey
    && browserService.isRunning() && activeTab?.url) {
    keptRegistry.register({
      conversationId: identity.conversationId,
      serviceKey,
      url: activeTab.url,
      title: activeTab.title || '',
      browserService,
      reason: 'takeover',
    });
  }
  if (stillShared) return;
  // A kept window survives its run's cleanup (agent keep, user claim release or a
  // takeover park alike). It stays pooled-but-idle: lease un-pinned and pool entry
  // not in use, so idle expiry / pool pressure can still reclaim it. Final URL/title
  // refresh so reopen restores where the run actually ended, not where keep was called.
  if (keptRegistry.isKeptServiceAlive(serviceKey)) {
    if (activeTab?.url) {
      keptRegistry.refreshTarget(identity.conversationId, activeTab.url, activeTab.title || '', serviceKey);
    }
    // Pool idle reclaim and the BrowserService lease remain in force.
    browserPool.setInUse(serviceKey, false);
  } else if (serviceKey !== input.personalServiceKey) {
    await input.releaseBrowser(serviceKey);
  }
}

/** Reuse takeover wording on the first result after the parked window is claimed. */
export function withTakeoverHandoffNote(result: ToolExecutionResult, attach: boolean): ToolExecutionResult {
  if (!attach) return result;
  const note = 'The user has handed the browser back after signing in: call get_dom_snapshot before acting '
    + '(takeover invalidates earlier observations).';
  return result.success
    ? { ...result, output: `${result.output ?? ''} ${note}`.trim() }
    : { ...result, error: `${result.error ?? ''} ${note}`.trim() };
}
