import { useEffect, useRef } from 'react';
import type { Language } from '../i18n';
import { useAppStore } from '../stores/appStore';
import { invokeNativeCommandAction, isNativeCommandRuntimeAvailable } from '../services/nativeCommandFacade';

/** Sync set_shell_language after settings hydration to preserve the cached startup language. */
export function useShellLanguage(settingsLoaded: boolean): void {
  const language = useAppStore((state) => state.language);
  const lastSent = useRef<Language | undefined>(undefined);
  useEffect(() => {
    if (!settingsLoaded || !isNativeCommandRuntimeAvailable() || lastSent.current === language) return;
    lastSent.current = language;
    void invokeNativeCommandAction('setShellLanguage', { lang: language }).catch((error: unknown) => {
      console.warn('[shell-language] Failed to sync menu language', error);
      if (lastSent.current === language) lastSent.current = undefined;
    });
  }, [language, settingsLoaded]);
}
