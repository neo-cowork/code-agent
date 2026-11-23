// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n';

const sessionState = {
  currentSessionId: 'session-1',
  sessions: [{ id: 'session-1', engine: { kind: 'native', permissionProfile: 'default', origin: 'manual' } }],
  updateSessionEngine: vi.fn(),
};

const appState = {
  modelConfig: { provider: 'xiaomi' },
  workingDirectory: null,
  openSettingsTab: vi.fn(),
};

const modeState = {
  effortLevel: 'high',
  effortLevelExplicit: false,
  setEffortLevel: vi.fn(),
  setAutomaticEffortLevel: vi.fn(),
  thinkingEnabled: true,
  setThinkingEnabled: vi.fn(),
  searchEnabled: true,
  setWebSearchEnabled: vi.fn(),
};

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));

vi.mock('../../../src/renderer/stores/modeStore', () => ({
  useModeStore: (selector: (state: typeof modeState) => unknown) => selector(modeState),
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: zh,
    language: 'zh',
    setLanguage: vi.fn(),
    availableLanguages: [],
    getCloudString: vi.fn(),
    cloudStrings: {},
  }),
}));

import { ModelSwitcher } from '../../../src/renderer/components/StatusBar/ModelSwitcher';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  delete (window as unknown as Record<string, unknown>).domainAPI;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).domainAPI;
});

describe('ModelSwitcher NeoHorse label', () => {
  it('shows the runtime-only friendly label in the native trigger and its title', () => {
    render(<ModelSwitcher currentModel="neohorse-1.5-flash-preview" />);

    const trigger = screen.getByRole('button', { name: '切换模型' });
    expect(trigger.textContent).toContain('NeoHorse 1.5 Flash');
    expect(trigger.textContent).not.toContain('neohorse-1.5-flash-preview');

    const title = trigger.getAttribute('title') ?? '';
    expect(title).toContain('NeoHorse 1.5 Flash');
    expect(title).not.toContain('neohorse-1.5-flash-preview');
  });
});
