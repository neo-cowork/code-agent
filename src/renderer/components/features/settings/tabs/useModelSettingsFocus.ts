import { useEffect, useRef } from 'react';
import type { ModelProvider } from '@shared/contract';
import { useAppStore } from '../../../../stores/appStore';

/** Consume the deep link only after provider settings and its key field are ready. */
export function useModelSettingsFocus(
  provider: ModelProvider,
  loaded: boolean,
  adding: boolean,
  selectProvider: (provider: ModelProvider) => void,
) {
  const panelRef = useRef<HTMLDivElement>(null);
  const focus = useAppStore((state) => state.settingsModelFocus);
  const clear = useAppStore((state) => state.clearSettingsModelFocus);
  useEffect(() => {
    if (!focus || !loaded) return;
    if (provider !== focus.provider || adding) {
      selectProvider(focus.provider);
      return;
    }
    const input = panelRef.current?.querySelector<HTMLInputElement>('input[data-model-api-key]');
    if (!input || input.disabled) return;
    const frame = requestAnimationFrame(() => {
      input.focus();
      if (document.activeElement === input) clear();
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, loaded, provider, adding, selectProvider, clear]);
  return panelRef;
}
