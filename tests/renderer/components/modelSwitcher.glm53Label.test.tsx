// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh, en } from '../../../src/renderer/i18n';

const ui = { language: 'zh' as 'zh' | 'en' };
const sessionState = {
  currentSessionId: 'session-1',
  sessions: [{ id: 'session-1', engine: { kind: 'native', permissionProfile: 'default', origin: 'manual', model: undefined as string | undefined } }],
  updateSessionEngine: vi.fn(),
};

const appState = {
  modelConfig: { provider: 'zhipu' },
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
    t: ui.language === 'en' ? en : zh,
    language: ui.language,
    setLanguage: vi.fn(),
    availableLanguages: [],
    getCloudString: vi.fn(),
    cloudStrings: {},
  }),
}));

import { ModelSwitcher } from '../../../src/renderer/components/StatusBar/ModelSwitcher';

const settingsWithLabel = {
  models: {
    default: 'zhipu',
    providers: {
      zhipu: {
        enabled: true,
        apiKeyConfigured: true,
        models: {
          'glm-5.3': { enabled: true, label: '用户 GLM-5.3' },
        },
      },
    },
    routing: {},
  },
};

function installDomainApi() {
  const invoke = vi.fn(async (_domain: string, action: string) => {
    if (action === 'get') return { success: true, data: settingsWithLabel };
    if (action === 'getModelOverride') return { success: true, data: null };
    if (action === 'getHealthStatus' || action === 'get_search_capabilities') {
      return { success: false, data: null };
    }
    if (action === 'listSources') return { success: true, data: [] };
    if (action === 'listModels') return { success: true, data: { catalog: null } };
    return { success: true, data: null };
  });
  Object.defineProperty(window, 'domainAPI', { configurable: true, value: { invoke } });
  return invoke;
}

beforeEach(() => {
  ui.language = 'zh';
  sessionState.sessions[0].engine.kind = 'native';
  sessionState.sessions[0].engine.model = undefined;
  Element.prototype.scrollIntoView = vi.fn();
  delete (window as unknown as Record<string, unknown>).domainAPI;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).domainAPI;
});

describe('ModelSwitcher GLM-5.3 label', () => {
  it('shows the runtime-only model label in the native trigger', () => {
    render(<ModelSwitcher currentModel="glm-5.3" />);

    const trigger = screen.getByRole('button', { name: '切换模型' });
    expect(trigger.textContent).toContain('GLM-5.3');
    expect(trigger.textContent).not.toContain('glm-5.3');
  });

  it('keeps a user model label override ahead of the runtime-only label', async () => {
    installDomainApi();
    render(<ModelSwitcher currentModel="glm-5.3" />);

    const trigger = screen.getByRole('button', { name: '切换模型' });
    fireEvent.click(trigger);

    await waitFor(() => expect(trigger.textContent).toContain('用户 GLM-5.3'));
    expect(trigger.textContent).not.toContain('glm-5.3');
  });
  it.each(['zh', 'en'] as const)('humanizes native and external status labels without changing model identity in %s', (language) => {
    ui.language = language;
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    for (const kind of ['native', 'codex']) {
      sessionState.sessions[0].engine.kind = kind;
      sessionState.sessions[0].engine.model = id;
      render(<ModelSwitcher currentModel={id} />);
      const trigger = screen.getByRole('button', { name: '切换模型' });
      expect(trigger.textContent).not.toContain(id);
      expect(trigger.title).not.toContain(id);
      expect(trigger.textContent).toContain(language === 'en' ? 'Internal record' : '内部记录');
      expect(sessionState.sessions[0].engine.model).toBe(id);
      cleanup();
    }
  });

});
