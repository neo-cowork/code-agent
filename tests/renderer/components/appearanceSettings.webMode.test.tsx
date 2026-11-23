// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppearanceSettings } from '../../../src/renderer/components/features/settings/tabs/AppearanceSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import ipcService from '../../../src/renderer/services/ipcService';
import { zhSettingsCore } from '../../../src/renderer/i18n/zhSettingsCore';
import { zhSettingsSystem } from '../../../src/renderer/i18n/zhSettingsSystem';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: vi.fn() },
}));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/utils/platform')>()),
  isWebMode: () => true,
}));

const appearance = zhSettingsCore.appearance;

function buttonsUnderHeading(heading: string): HTMLButtonElement[] {
  const section = screen.getByRole('heading', { name: heading }).parentElement;
  if (!section) throw new Error(`missing section for ${heading}`);
  return [...section.querySelectorAll('button')];
}

describe('AppearanceSettings web mode', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })) as never;
    localStorage.setItem('code-agent-theme', 'dark');
    useAppStore.setState({ developerMode: false, disclosureLevel: 'standard', language: 'zh' });
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => (
      action === 'get' ? { ui: { fontSize: 14 } } : undefined
    ));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useAppStore.setState({ developerMode: false, disclosureLevel: 'standard', language: 'zh' });
  });

  it('enables theme, font size, language and detail level, and saving language calls setLanguage', () => {
    const setLanguage = vi.spyOn(useAppStore.getState(), 'setLanguage');
    render(<AppearanceSettings />);

    const groups = {
      theme: buttonsUnderHeading(appearance.theme),
      fontSize: buttonsUnderHeading(appearance.fontSize),
      language: buttonsUnderHeading(appearance.languageTitle),
      detailLevel: buttonsUnderHeading(appearance.disclosureLevel),
    };
    expect(groups.theme).toHaveLength(5);
    expect(groups.fontSize).toHaveLength(3);
    expect(groups.language).toHaveLength(2);
    expect(groups.detailLevel).toHaveLength(4);
    for (const button of [...groups.theme, ...groups.fontSize, ...groups.language, ...groups.detailLevel]) {
      expect(button.disabled).toBe(false);
    }
    expect(screen.queryByText(zhSettingsSystem.webModeBanner.desktopOnlyFeature)).toBeNull();

    const english = groups.language.find((button) => button.textContent?.includes('English'));
    expect(english).toBeTruthy();
    fireEvent.click(english!);

    expect(setLanguage).toHaveBeenCalledWith('en');
    expect(useAppStore.getState().language).toBe('en');
    expect(ipcService.invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
      ui: { language: 'en' },
    });
  });
});
