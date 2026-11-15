import React, { useState } from 'react';
import { initializeAuthStore, useAuthStore } from '../../../stores/authStore';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { Button } from '../../primitives/Button';
import { SidebarSignedOutFooter } from './SidebarSignedOutFooter';

export function SidebarAccountStatus() {
  const { t } = useI18n();
  const statusLoadFailed = useAuthStore((state) => state.statusLoadFailed);
  const setShowSettings = useAppStore((state) => state.setShowSettings);
  const [retrying, setRetrying] = useState(false);
  if (!statusLoadFailed) return <SidebarSignedOutFooter />;
  return (
    <div className="space-y-2" data-testid="sidebar-account-unreachable">
      <p role="status" className="text-xs text-zinc-400">{t.sidebar.accountUnreachable}</p>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={retrying} onClick={async () => {
          setRetrying(true);
          try { await initializeAuthStore(); } finally { setRetrying(false); }
        }}>{t.sidebar.connectionRetry}</Button>
        <Button variant="secondary" onClick={() => setShowSettings(true)}>{t.sidebar.signedOutSettings}</Button>
      </div>
    </div>
  );
}
