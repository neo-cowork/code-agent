import { useEffect } from 'react';
import { formatActionShortcut } from '@shared/keybindings';
import { useKeybindingsSettings } from '../../../hooks/useKeybindingsSettings';
import { useI18n } from '../../../hooks/useI18n';

export function useSidebarSearchShortcut(openSearchDialog: () => void): string {
  const { keybindings, platform } = useKeybindingsSettings();
  const { t } = useI18n();
  useEffect(() => {
    window.addEventListener('app:openSessionSearch', openSearchDialog);
    return () => window.removeEventListener('app:openSessionSearch', openSearchDialog);
  }, [openSearchDialog]);
  return formatActionShortcut(keybindings, 'sessionSearch.open', platform) || t.settings.conversation.notSet;
}
