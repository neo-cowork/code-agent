// BrowserService stays free of surfaceExecution imports: the surfaceExecution
// layer registers one resume hook, and BrowserService calls it from its launch
// layer (cold launch, same-process reuse) when an entry passes conversationId.
import type { BrowserService } from '../browserService';
import type { ManagedBrowserLaunchOptions } from './types';

export type BrowserLaunchResumePhase = 'cold' | 'reuse';

export type BrowserLaunchResumeHook = (input: {
  service: BrowserService;
  conversationId: string;
  phase: BrowserLaunchResumePhase;
}) => Promise<void>;

let launchResumeHook: BrowserLaunchResumeHook | null = null;
const resumeOwners = new WeakMap<object, string>();

export function setBrowserLaunchResumeHook(hook: BrowserLaunchResumeHook | null): void {
  launchResumeHook = hook;
}

/** Which conversation's last page/login state the window currently carries. */
export function markBrowserLaunchResumeOwner(service: object, conversationId: string): void {
  resumeOwners.set(service, conversationId);
}

export function getBrowserLaunchResumeOwner(service: object): string | undefined {
  return resumeOwners.get(service);
}

/** Never throws: a failed resume must not block the launch. */
export async function runBrowserLaunchResume(
  service: BrowserService,
  options: ManagedBrowserLaunchOptions,
  phase: BrowserLaunchResumePhase,
): Promise<void> {
  if (!launchResumeHook || !options.conversationId) return;
  try {
    await launchResumeHook({ service, conversationId: options.conversationId, phase });
  } catch {
    // The hook logs its own distinguishable reasons.
  }
}
