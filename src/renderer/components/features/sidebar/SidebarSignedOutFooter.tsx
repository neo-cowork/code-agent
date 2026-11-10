import React from 'react';
import { LogIn, Settings } from 'lucide-react';
import { useAuthStore } from '../../../stores/authStore';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { Button } from '../../primitives/Button';

export function SidebarSignedOutFooter() {
  const { t } = useI18n();
  const setShowAuthModal = useAuthStore((state) => state.setShowAuthModal);
  const setShowSettings = useAppStore((state) => state.setShowSettings);
  return (
    <div className="flex gap-2" data-testid="sidebar-signed-out-footer">
      <Button variant="secondary" className="flex-1" leftIcon={<LogIn className="h-4 w-4" />} onClick={() => setShowAuthModal(true)}>
        {t.sidebar.signIn}
      </Button>
      <Button variant="secondary" className="flex-1" leftIcon={<Settings className="h-4 w-4" />} onClick={() => {
        setShowAuthModal(false);
        setShowSettings(true);
      }}>
        {t.sidebar.signedOutSettings}
      </Button>
    </div>
  );
}
