// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n';

const sessionState = {
  currentSessionId: 'session-1',
  sessions: [{ id: 'session-1', engine: { kind: 'native', permissionProfile: 'default', origin: 'manual' } }],
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
    t: zh,
    language: 'zh',
    setLanguage: vi.fn(),
    availableLanguages: [],
    getCloudString: vi.fn(),
    cloudStrings: {},
  }),
}));

import { ModelSwitcher } from '../../../src/renderer/components/StatusBar/ModelSwitcher';

// 设置还没到之前，选择器不能把内置全目录（含已停用模型）闪出来。
const settings = {
  models: {
    default: 'zhipu',
    providers: {
      zhipu: {
        enabled: true,
        apiKeyConfigured: true,
        models: {
          'glm-5.1': { enabled: true },
          'glm-4.7': { enabled: false },
        },
      },
    },
    routing: {},
  },
};

type Reply = { success: boolean; data: unknown };
let settingsReply: Promise<Reply>;

function installDomainApi() {
  const invoke = vi.fn(async (_domain: string, action: string) => {
    if (action === 'get') return settingsReply;
    if (action === 'getModelOverride') return { success: true, data: null };
    if (action === 'listSources') return { success: true, data: [] };
    if (action === 'listModels') return { success: true, data: { catalog: null } };
    return { success: false, data: null };
  });
  Object.defineProperty(window, 'domainAPI', { configurable: true, value: { invoke } });
}

const rows = () => Array.from(document.querySelectorAll('[data-model-option-index]'))
  .map((el) => (el.textContent ?? '').trim());
const hasRow = (list: string[], re: RegExp) => list.some((text) => re.test(text));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).domainAPI;
});

describe('ModelSwitcher 设置未到位时的瞬态列表', () => {
  it('设置请求挂起：只有自动 + 当前模型，没有已停用模型；放行后列表只增不减且按启用过滤', async () => {
    let release!: (reply: Reply) => void;
    settingsReply = new Promise<Reply>((resolve) => { release = resolve; });
    installDomainApi();
    render(<ModelSwitcher currentModel="glm-5.1" />);
    fireEvent.click(screen.getByRole('button', { name: '切换模型' }));

    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    const during = rows();
    expect(hasRow(during, /5\.1/)).toBe(true);
    expect(hasRow(during, /glm-4\.7$/)).toBe(false);
    expect(during.length).toBe(2);

    await act(async () => { release({ success: true, data: settings }); });
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    const after = rows();
    expect(hasRow(after, /glm-4\.7$/)).toBe(false);
    for (const text of during) expect(after).toContain(text);
  });

  it('设置读取失败：回落到内置列表，行为不变', async () => {
    settingsReply = Promise.reject(new Error('settings unavailable'));
    settingsReply.catch(() => {});
    installDomainApi();
    render(<ModelSwitcher currentModel="glm-5.1" />);
    fireEvent.click(screen.getByRole('button', { name: '切换模型' }));

    await waitFor(() => expect(rows().length).toBeGreaterThan(2));
    expect(hasRow(rows(), /glm-4\.7$/)).toBe(true);
  });
});
