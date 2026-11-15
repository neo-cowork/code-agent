import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

const SETTINGS_PANES = {
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenCapture: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  inputMonitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
} as const;

/** Local macOS web builds can open settings too, provided there is a logged-in desktop. */
export function canOpenEnvSettings(): boolean {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/open')) return false;
  try {
    const owner = statSync('/dev/console').uid;
    return owner !== 0 && owner === process.getuid?.();
  } catch { return false; }
}

export async function openEnvSettings(pane: string): Promise<boolean> {
  if (!Object.hasOwn(SETTINGS_PANES, pane)) return false;
  const url = SETTINGS_PANES[pane as keyof typeof SETTINGS_PANES];
  return new Promise((resolve) => execFile('open', [url], (error) => resolve(!error)));
}
