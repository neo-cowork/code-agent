import React, { useEffect } from 'react';
import { useAppStore } from '../../../stores/appStore';
import { ErrorBoundary } from '../../ErrorBoundary';
import { SettingsLoadFallback } from './SettingsLoadFallback';

const SettingsModal = React.lazy(() => import('../../SettingsModal').then(({ SettingsModal }) => ({
  default: SettingsModal,
})));
const REOPEN_SETTINGS_KEY = 'code-agent-reopen-settings-after-reload';

function SettingsShellFallback() {
  const closeSettings = useAppStore((state) => state.closeSettings);

  useEffect(() => {
    try {
      sessionStorage.setItem(REOPEN_SETTINGS_KEY, '1');
      return () => sessionStorage.removeItem(REOPEN_SETTINGS_KEY);
    } catch {
      // Storage can be disabled. The user can open Settings again after reloading.
    }
  }, []);

  return (
    <div className="shrink-0 border-b border-zinc-800 px-4 py-3">
      <SettingsLoadFallback onClose={closeSettings} />
    </div>
  );
}

export function SettingsShell({ active }: { active: boolean }) {
  useEffect(() => {
    try {
      const reopen = sessionStorage.getItem(REOPEN_SETTINGS_KEY) === '1';
      sessionStorage.removeItem(REOPEN_SETTINGS_KEY);
      // A new document gets a fresh lazy module cache. Restore the interrupted open attempt once.
      if (reopen && (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload') {
        useAppStore.getState().setShowSettings(true);
      }
    } catch {
      // Settings can still be opened manually when storage is unavailable.
    }
  }, []);

  if (!active) return null;
  return (
    <ErrorBoundary fallback={<SettingsShellFallback />}>
      <React.Suspense fallback={null}>
        <SettingsModal />
      </React.Suspense>
    </ErrorBoundary>
  );
}
