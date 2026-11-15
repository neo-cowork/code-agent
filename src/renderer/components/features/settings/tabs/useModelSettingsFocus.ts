import { useEffect, useRef } from 'react';
import type { ModelProvider } from '@shared/contract';
import { useAppStore } from '../../../../stores/appStore';

/** Consume the deep link once provider settings are ready; clear even when the key input cannot be focused. */
export function useModelSettingsFocus(
  provider: ModelProvider,
  loaded: boolean,
  adding: boolean,
  selectProvider: (provider: ModelProvider) => void,
) {
  const panelRef = useRef<HTMLDivElement>(null);
  const switchedNonceRef = useRef<number | null>(null);
  const focus = useAppStore((state) => state.settingsModelFocus);
  const clear = useAppStore((state) => state.clearSettingsModelFocus);
  useEffect(() => {
    if (!focus || !loaded) return;
    if (provider !== focus.provider || adding) {
      if (switchedNonceRef.current !== focus.nonce) {
        switchedNonceRef.current = focus.nonce;
        selectProvider(focus.provider);
      }
      return;
    }
    const input = panelRef.current?.querySelector<HTMLInputElement>('input[data-model-api-key]');
    if (input && !input.disabled) {
      input.focus();
    }
    clear();
  }, [focus, loaded, provider, adding, selectProvider, clear]);
  return panelRef;
}
