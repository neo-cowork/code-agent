import type { ManagedBrowserProfileMode } from '../../../../shared/contract/desktop';
import type { BrowserService } from '../browserService';
import type { ManagedBrowserLaunchOptions } from './types';

export interface ManagedBrowserLaunchResumeInput {
  conversationId?: string;
  launchedFresh: boolean;
  profileMode?: ManagedBrowserProfileMode;
}

export type ManagedBrowserLaunchResumeHook = (
  service: BrowserService,
  input: ManagedBrowserLaunchResumeInput,
) => Promise<void>;

let hook: ManagedBrowserLaunchResumeHook | null = null;

/** Surface execution registers the resume hook. Infra never imports that layer. */
export function registerManagedBrowserLaunchResumeHook(next: ManagedBrowserLaunchResumeHook): void {
  hook = next;
}

async function runManagedBrowserLaunchResume(
  service: BrowserService,
  input: ManagedBrowserLaunchResumeInput,
): Promise<void> {
  if (!hook || !input.conversationId) return;
  await hook(service, input);
}

/**
 * One resume attempt per public launch / ensureSession.
 * A fresh isolated launch opens a blank tab first so login import can see a page.
 */
export async function finishManagedBrowserLaunchResume(
  service: BrowserService,
  options: ManagedBrowserLaunchOptions,
  launchedFresh: boolean,
): Promise<void> {
  if (service.isLaunchResumeSuppressed()) return;
  // A window that is already running keeps the profile it was opened with; the
  // request's profileMode must not turn a persistent personal window into an isolated jar.
  const liveProfileMode = service.getSessionState().profileMode;
  const profileMode = launchedFresh ? (options.profileMode ?? liveProfileMode) : liveProfileMode;
  if (
    launchedFresh
    && options.conversationId
    && profileMode === 'isolated'
    && !service.getActiveTab()
  ) {
    await service.newTab();
  }
  await runManagedBrowserLaunchResume(service, {
    conversationId: options.conversationId,
    launchedFresh,
    profileMode,
  });
}
