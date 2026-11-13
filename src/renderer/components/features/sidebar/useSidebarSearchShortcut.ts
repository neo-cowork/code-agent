import { useEffect } from 'react';
import { formatActionShortcut } from '@shared/keybindings';
import { useKeybindingsSettings } from '../../../hooks/useKeybindingsSettings';

export function useSidebarSearchShortcut(openSearchDialog: () => void): string {
  const { keybindings, platform } = useKeybindingsSettings();
  useEffect(() => {
    window.addEventListener('app:openSessionSearch', openSearchDialog);
    return () => window.removeEventListener('app:openSessionSearch', openSearchDialog);
  }, [openSearchDialog]);
  return formatActionShortcut(keybindings, 'sessionSearch.open', platform);
}
