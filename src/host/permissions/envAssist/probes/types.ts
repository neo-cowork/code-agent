/* eslint-disable @typescript-eslint/naming-convention -- Preserve native macOS API names at the injected boundary. */
export type ProbeResult =
  | { status: 'granted' | 'denied' | 'undecided' | 'not_running' }
  | { status: 'unavailable'; reason: string };

export type ReadOnlyProbe = () => Promise<ProbeResult>;

/** Native implementations must use only the non-prompting variants. */
export interface PassiveBridge {
  AXIsProcessTrusted(): Promise<boolean>;
  CGPreflightScreenCaptureAccess(): Promise<boolean>;
  AEDeterminePermissionToAutomateTarget(targetBundleId: string, askUserIfNeeded: false): Promise<0 | -1743 | -1744 | -600>;
}

/** Declaration only; consumption is restricted to the grant boundary. */
export interface PromptingBridge {
  requestAccessibility(): Promise<void>;
  CGRequestScreenCaptureAccess(): Promise<void>;
  AEDeterminePermissionToAutomateTarget(targetBundleId: string, askUserIfNeeded: true): Promise<void>;
}
