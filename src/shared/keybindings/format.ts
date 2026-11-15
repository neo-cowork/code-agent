import { getCurrentKeybindingPlatform, getKeybindingAccelerator } from './defaults';
import type { KeybindingActionId, KeybindingPlatform, KeybindingsSettings } from './types';

function formatKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  if (key.toLowerCase() === 'escape') return 'Esc';
  if (key.toLowerCase() === 'space') return 'Space';
  return key;
}

/** 未绑定时返回空串：「未设置」这类给人看的词由调用方按界面语言补，shared 层不带文案。 */
export function formatShortcutForDisplay(
  accelerator: string | null | undefined,
  platform: KeybindingPlatform = getCurrentKeybindingPlatform()
): string {
  if (!accelerator) return '';
  const parts = accelerator.split('+').filter(Boolean);
  if (parts.length === 0) return '';
  if (platform === 'darwin') {
    return parts.map((part) => {
      const normalized = part.toLowerCase();
      if (normalized === 'cmd' || normalized === 'command') return '⌘';
      if (normalized === 'ctrl' || normalized === 'control') return '⌃';
      if (normalized === 'alt' || normalized === 'option') return '⌥';
      if (normalized === 'shift') return '⇧';
      return formatKey(part);
    }).join('');
  }
  return parts.map((part) => {
    const normalized = part.toLowerCase();
    if (normalized === 'cmd' || normalized === 'command') return 'Win';
    if (normalized === 'control') return 'Ctrl';
    if (normalized === 'option') return 'Alt';
    return formatKey(part);
  }).join('+');
}

export function formatActionShortcut(
  settings: KeybindingsSettings | undefined,
  actionId: KeybindingActionId,
  platform: KeybindingPlatform = getCurrentKeybindingPlatform()
): string {
  return formatShortcutForDisplay(getKeybindingAccelerator(settings, actionId, platform), platform);
}
