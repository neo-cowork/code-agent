import { createHash } from 'node:crypto';
import type { BrowserService } from '../infra/browserService';
import { browserPool } from '../infra/browserPool';
import type { ManagedBrowserLaunchResumeInput } from '../infra/browser/launchResumeHook';
import { registerManagedBrowserLaunchResumeHook } from '../infra/browser/launchResumeHook';
import { createLogger } from '../infra/logger';
import type { BrowserLastPageStore } from './browserLastPageStore';
import type { BrowserResumeStateStore } from './BrowserResumeStateStore';

const fallbackLogger = createLogger('ManagedBrowserLaunchResume');

export type BrowserResumeFailureCode =
  | 'BROWSER_RESUME_STATE_EXPORT_FAILED'
  | 'BROWSER_RESUME_STATE_IMPORT_FAILED';

export class BrowserResumeStateError extends Error {
  constructor(readonly code: BrowserResumeFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BrowserResumeStateError';
  }
}

interface LaunchResumeLogger {
  info?(message: string, metadata?: unknown): void;
  warn?(message: string, metadata?: unknown): void;
}

export interface ManagedBrowserLaunchResumeDeps {
  resumeStateStore: BrowserResumeStateStore;
  lastPageStore: BrowserLastPageStore;
  logger?: LaunchResumeLogger;
}

type ResumePhase = 'cold' | 'reuse-same' | 'swap' | 'skipped';

interface ResumeLogFields {
  phase: ResumePhase;
  reason: string;
  conversationIdHash: string;
  url: string | null;
  error?: string;
}

let deps: ManagedBrowserLaunchResumeDeps | null = null;

/** Archive version each window last imported or exported; a newer archive means the window's cookies are stale. */
const windowArchiveVersion = new WeakMap<object, number>();

export function installManagedBrowserLaunchResume(next: ManagedBrowserLaunchResumeDeps): void {
  deps = next;
  registerManagedBrowserLaunchResumeHook(resumeManagedBrowserOnLaunch);
}

function conversationIdHash(conversationId: string): string {
  return createHash('sha256').update(conversationId).digest('hex').slice(0, 24);
}

function logResume(level: 'info' | 'warn', fields: ResumeLogFields): void {
  const logger = deps?.logger ?? fallbackLogger;
  logger[level]?.('Managed browser launch resume', fields);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBlank(url: string | null | undefined): boolean {
  // A refused navigation leaves Chrome on chrome-error://, not about:blank.
  // That page is not a site the user landed on, so the next launch retries it.
  return !url || url === 'about:blank' || url.startsWith('chrome-error://');
}

function readActiveUrl(service: BrowserService): string | null {
  const tab = service.getActiveTab();
  if (!tab) return null;
  try {
    const live = service.getLiveTabUrl(tab.id);
    if (live) return live;
  } catch {
    // The page can close between the tab list and the live read.
  }
  return tab.url || null;
}

function servicePoolInUse(service: object): boolean {
  const read = (browserPool as { managedServices?: () => Array<{ service: object; inUse: boolean }> }).managedServices;
  if (typeof read !== 'function') return false;
  try {
    return read.call(browserPool).some((entry) => entry.service === service && entry.inUse);
  } catch {
    return false;
  }
}

/** Idle means no Surface binding and no lease held by another run. */
function windowBusy(service: BrowserService): boolean {
  return service.isLeaseInUse() || servicePoolInUse(service);
}

async function readLastPage(conversationId: string): Promise<string | null> {
  if (!deps) return null;
  return deps.lastPageStore.getForConversation(conversationId);
}

/**
 * Import into a jar that was just created. Owner is recorded when the import
 * returns, including an empty archive, and before navigation.
 */
async function seedFreshJar(
  service: BrowserService,
  conversationId: string,
): Promise<{ url: string | null; navigated: boolean; navError?: string }> {
  if (!deps) {
    throw new BrowserResumeStateError(
      'BROWSER_RESUME_STATE_IMPORT_FAILED',
      'Browser login state could not be restored. The browser started without the previous login state.',
    );
  }
  try {
    await deps.resumeStateStore.importForConversation(conversationId, service, { consume: false });
  } catch (error) {
    throw new BrowserResumeStateError(
      'BROWSER_RESUME_STATE_IMPORT_FAILED',
      'Browser login state could not be restored. The browser started without the previous login state.',
      { cause: error },
    );
  }
  service.setResumeOwner(conversationId);
  windowArchiveVersion.set(service, (deps.resumeStateStore.archiveVersion?.(conversationId) ?? 0));
  let target: string | null;
  try {
    target = await readLastPage(conversationId);
  } catch (error) {
    return { url: null, navigated: false, navError: errorMessage(error) };
  }
  if (!target) return { url: null, navigated: false };
  try {
    await service.navigate(target);
    return { url: target, navigated: true };
  } catch (error) {
    return { url: target, navigated: false, navError: errorMessage(error) };
  }
}

function logSeed(phase: ResumePhase, conversationId: string, seeded: { url: string | null; navigated: boolean; navError?: string }): void {
  const base = {
    phase,
    conversationIdHash: conversationIdHash(conversationId),
    url: seeded.url,
  };
  if (seeded.navError && seeded.url) {
    logResume('warn', { ...base, reason: 'last_page_navigation_failed', error: seeded.navError });
    return;
  }
  if (seeded.navError && !seeded.url) {
    logResume('warn', { ...base, reason: 'last_page_read_failed', error: seeded.navError });
    return;
  }
  logResume('info', {
    ...base,
    reason: seeded.navigated ? 'last_page_restored' : 'resume_seeded',
  });
}

async function reuseSame(service: BrowserService, conversationId: string): Promise<void> {
  const hash = conversationIdHash(conversationId);
  if (!isBlank(readActiveUrl(service))) {
    service.notifyLaunchResume();
    logResume('info', {
      phase: 'reuse-same',
      reason: 'resume_reused',
      conversationIdHash: hash,
      url: readActiveUrl(service),
    });
    return;
  }
  let target: string | null = null;
  let navError: string | undefined;
  try {
    target = await readLastPage(conversationId);
  } catch (error) {
    navError = errorMessage(error);
  }
  if (target && !navError) {
    try {
      await service.navigate(target);
    } catch (error) {
      navError = errorMessage(error);
    }
  }
  service.notifyLaunchResume();
  if (navError) {
    logResume('warn', {
      phase: 'reuse-same',
      reason: target ? 'last_page_navigation_failed' : 'last_page_read_failed',
      conversationIdHash: hash,
      url: target,
      error: navError,
    });
    return;
  }
  logResume('info', {
    phase: 'reuse-same',
    reason: target ? 'last_page_restored' : 'resume_reused',
    conversationIdHash: hash,
    url: target ?? readActiveUrl(service),
  });
}

async function replaceJar(service: BrowserService, conversationId: string, phase: 'swap' | 'cold'): Promise<void> {
  const store = deps?.resumeStateStore;
  if (!store) return;
  const previous = service.getResumeOwner();
  if (previous) {
    const stale = (store.archiveVersion?.(previous) ?? 0) !== (windowArchiveVersion.get(service) ?? 0);
    if (stale) {
      // Another run wrote a newer login for the previous owner; this window's cookies must not overwrite it.
      logResume('info', {
        phase,
        reason: 'resume_export_skipped_stale',
        conversationIdHash: conversationIdHash(previous),
        url: readActiveUrl(service),
      });
    } else {
      try {
        await store.exportForConversation(previous, service);
      } catch (error) {
        logResume('warn', {
          phase: 'skipped',
          reason: 'resume_skipped_export_failed',
          conversationIdHash: conversationIdHash(conversationId),
          url: readActiveUrl(service),
          error: errorMessage(error),
        });
        // Keep the window with its current owner; never hand it to another conversation.
        throw new BrowserResumeStateError(
          'BROWSER_RESUME_STATE_EXPORT_FAILED',
          'Browser login state could not be saved before switching conversations. The browser was left unchanged.',
          { cause: error },
        );
      }
    }
  }
  await service.close();
  await service.relaunchIsolatedForResume();
  const seeded = await seedFreshJar(service, conversationId);
  logSeed(phase, conversationId, seeded);
}

async function resumeManagedBrowserOnLaunch(
  service: BrowserService,
  input: ManagedBrowserLaunchResumeInput,
): Promise<void> {
  const conversationId = input.conversationId?.trim();
  if (!conversationId) return;
  if (input.profileMode !== 'isolated') return;
  if (!deps) {
    logResume('warn', {
      phase: 'skipped',
      reason: 'resume_skipped_unconfigured',
      conversationIdHash: conversationIdHash(conversationId),
      url: null,
    });
    return;
  }

  if (!input.launchedFresh && service.isRunning()) {
    if (service.getResumeOwner() === conversationId) {
      await reuseSame(service, conversationId);
      return;
    }
    if (windowBusy(service)) {
      logResume('warn', {
        phase: 'skipped',
        reason: 'resume_skipped_window_busy',
        conversationIdHash: conversationIdHash(conversationId),
        url: readActiveUrl(service),
      });
      return;
    }
    const current = readActiveUrl(service);
    if (!service.getResumeOwner() && !isBlank(current)) {
      logResume('warn', {
        phase: 'skipped',
        reason: 'resume_skipped_unowned',
        conversationIdHash: conversationIdHash(conversationId),
        url: current,
      });
      return;
    }
    await replaceJar(service, conversationId, service.getResumeOwner() ? 'swap' : 'cold');
    return;
  }

  logSeed('cold', conversationId, await seedFreshJar(service, conversationId));
}
