import { createHash } from 'node:crypto';
import type { BrowserLaunchResumeHook } from '../infra/browser/launchResumeHook';
import { getBrowserLaunchResumeOwner } from '../infra/browser/launchResumeHook';
import type { BrowserResumeStateStore } from './BrowserResumeStateStore';
import { restoreManagedBrowserLastPage, type BrowserLastPageStore } from './browserLastPageStore';

interface LaunchResumeLogger {
  info?(message: string, metadata?: unknown): void;
  warn?(message: string, metadata?: unknown): void;
}

/**
 * Restores a conversation's last page and login state at the BrowserService
 * launch layer. Entries that already restore through the adapter's explicit
 * identity path do not pass conversationId, so nothing runs twice.
 */
export function createBrowserLaunchResumeHook(deps: {
  resumeStateStore: BrowserResumeStateStore;
  lastPageStore: BrowserLastPageStore;
  logger: LaunchResumeLogger;
}): BrowserLaunchResumeHook {
  return async ({ service, conversationId, phase }) => {
    const conversationIdHash = createHash('sha256').update(JSON.stringify([conversationId])).digest('hex').slice(0, 24);
    if (phase === 'reuse') {
      const url = service.getActiveTab()?.url;
      const blank = !url || url === 'about:blank';
      if (getBrowserLaunchResumeOwner(service) === conversationId && !blank) return;
    }
    try {
      // The import consumes the saved slot; put the state back from this window so a
      // chat run of the same conversation (a different window) can still restore it.
      if (await deps.resumeStateStore.importForConversation(conversationId, service)) {
        await deps.resumeStateStore.exportForConversation(conversationId, service);
      }
    } catch (error) {
      deps.logger.warn?.('Failed to restore managed browser login state at launch; continuing signed out', {
        reason: 'login_state_import_failed',
        phase,
        conversationIdHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      if (!service.getActiveTab()) await service.newTab();
    } catch (error) {
      deps.logger.warn?.('Failed to open a tab for managed browser last page; continuing on blank page', {
        reason: 'last_page_tab_failed',
        phase,
        conversationIdHash,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    await restoreManagedBrowserLastPage({
      conversationId,
      conversationIdHash,
      browserService: service,
      store: deps.lastPageStore,
      logger: deps.logger,
      phase,
    });
  };
}
