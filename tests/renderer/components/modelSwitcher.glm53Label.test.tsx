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

import { listExternalEngineManifests } from '../../../src/shared/externalEngineManifest';
import { ModelSwitcher } from '../../../src/renderer/components/StatusBar/ModelSwitcher';
import {
  buildEngineReliabilitySummary, buildProviderBillingSummary, buildProviderHealthSummary,
  ProviderBillingBadge, ProviderHealthBadge, ProviderSourceBadge, ProviderTransportBadge,
} from '../../../src/renderer/components/StatusBar/modelSwitcherHelpers';

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

const xiaomiSettings = {
  models: {
    default: 'xiaomi',
    providers: {
      xiaomi: {
        enabled: true,
        apiKeyConfigured: true,
        models: { 'mimo-v2.5-pro': { enabled: true }, 'mimo-v2.5-flash': { enabled: true } },
      },
    },
    routing: {},
  },
};

// Engines that are listed but cannot be picked yet carry a status label from the shared manifest.
const engineSources = { list: [] as unknown[] };
const recommendedSources = listExternalEngineManifests().filter((manifest) => manifest.recommendation).map((manifest) => ({
  manifestId: manifest.id, label: manifest.label, summary: '', detected: false, selectable: false, authState: 'unknown',
  modelSelection: 'unavailable', evidence: 'none', credentialOwner: 'official_client', auditNotes: [],
  recommendation: manifest.recommendation,
}));

function installDomainApi(settings: unknown = settingsWithLabel, health: Record<string, unknown> | null = null, override: unknown = null) {
  const invoke = vi.fn(async (_domain: string, action: string) => {
    if (action === 'get') return { success: true, data: settings };
    if (action === 'getModelOverride') return { success: true, data: override };
    if (action === 'getHealthStatus') return health ? { success: true, data: health } : { success: false, data: null };
    if (action === 'get_search_capabilities') {
      return { success: false, data: null };
    }
    if (action === 'listSources') return { success: true, data: engineSources.list };
    if (action === 'listModels') return { success: true, data: { catalog: null } };
    return { success: true, data: null };
  });
  Object.defineProperty(window, 'domainAPI', { configurable: true, value: { invoke } });
  return invoke;
}

beforeEach(() => {
  engineSources.list = [];
  ui.language = 'zh';
  appState.modelConfig.provider = 'zhipu';
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
      const trigger = screen.getByRole('button', { name: (language === 'en' ? en : zh).settings.model.models.switcherPanel.triggerAria });
      expect(trigger.textContent).not.toContain(id);
      expect(trigger.title).not.toContain(id);
      expect(trigger.textContent).toContain(language === 'en' ? 'Internal record' : '内部记录');
      expect(sessionState.sessions[0].engine.model).toBe(id);
      cleanup();
    }
  });

  // Every piece of text a user can read or hover in the status-bar switcher: text nodes plus title / aria-label / placeholder.
  const visibleText = () => [
    document.body.textContent ?? '',
    ...Array.from(document.body.querySelectorAll('[title],[aria-label],[placeholder]')).flatMap((el) => [
      el.getAttribute('title') ?? '', el.getAttribute('aria-label') ?? '', el.getAttribute('placeholder') ?? '',
    ]),
  ].join('\n');
  const CJK = /[\u3400-\u9fff]/;

  it('English UI: trigger, opened panel and provider health marks contain no Chinese text', async () => {
    ui.language = 'en';
    appState.modelConfig.provider = 'xiaomi';
    installDomainApi(xiaomiSettings, {
      xiaomi: { status: 'unavailable', latencyP50: 4200, errorRate: 0.91, providerMark: { kind: 'auth' } },
    });
    render(<ModelSwitcher currentModel="mimo-v2.5-pro" />);
    const trigger = screen.getByRole('button', { name: en.settings.model.models.switcherPanel.triggerAria });
    fireEvent.click(trigger);
    await waitFor(() => expect(document.body.querySelector('[data-model-search-input]')).not.toBeNull());
    await waitFor(() => expect(document.body.querySelectorAll('[data-model-option-index]').length).toBeGreaterThan(1));
    await waitFor(() => expect(visibleText()).toContain(en.settings.model.models.switcherPanel.availability.auth));
    expect(visibleText()).toContain(en.settings.model.models.switcherPanel.header);
    expect(visibleText()).toContain(en.settings.model.models.switcherPanel.auto);
    expect(visibleText().split('\n').filter((line) => CJK.test(line))).toEqual([]);
  });

  it('English UI: the adaptive trigger label, the empty state, the engine picker and the helper badges contain no Chinese text', async () => {
    ui.language = 'en';
    appState.modelConfig.provider = 'xiaomi';
    engineSources.list = recommendedSources;
    expect(recommendedSources.length).toBeGreaterThan(0);
    installDomainApi(xiaomiSettings, null, { adaptive: true });
    const first = render(<ModelSwitcher currentModel="mimo-v2.5-pro" />);
    const trigger = screen.getByRole('button', { name: en.settings.model.models.switcherPanel.triggerAria });
    await waitFor(() => expect(trigger.textContent).toBe(en.settings.model.models.switcherPanel.auto));
    fireEvent.click(trigger);
    await waitFor(() => expect(document.body.querySelector('[data-current-engine-row]')).not.toBeNull());
    fireEvent.click(document.body.querySelector('[data-current-engine-row] button') as HTMLElement);
    await waitFor(() => expect(document.body.querySelector('[data-engine-picker]')).not.toBeNull());
    await waitFor(() => expect(document.body.querySelectorAll('[data-engine-source]').length).toBe(recommendedSources.length));
    expect(visibleText().split('\n').filter((line) => CJK.test(line))).toEqual([]);
    first.unmount();

    installDomainApi({ models: { default: 'xiaomi', providers: {}, routing: {} } });
    render(<ModelSwitcher currentModel="mimo-v2.5-pro" />);
    const emptyTrigger = screen.getByRole('button', { name: en.settings.model.models.switcherPanel.triggerAria });
    fireEvent.click(emptyTrigger);
    await waitFor(() => expect(emptyTrigger.textContent).toBe(en.settings.model.models.switcherPanel.configureModel));
    expect(visibleText().split('\n').filter((line) => CJK.test(line))).toEqual([]);
    cleanup();

    const text = en.settings.model.models.switcherPanel;
    render(<>
      <ProviderBillingBadge summary={buildProviderBillingSummary('payg', text)} />
      <ProviderBillingBadge summary={buildProviderBillingSummary('unknown', text)} />
      <ProviderHealthBadge summary={buildProviderHealthSummary({ status: 'unavailable', latencyP50: 4200, errorRate: 0.91 }, text)} />
      <ProviderHealthBadge summary={buildProviderHealthSummary(null, text)} />
      <ProviderSourceBadge sourceLabel="CommonStack" />
      <ProviderTransportBadge protocol="openai" endpoint="https://commonstack.example/v1" />
    </>);
    expect(visibleText().split('\n').filter((line) => CJK.test(line))).toEqual([]);
    const reliability = buildEngineReliabilitySummary({
      descriptor: {
        kind: 'codex_cli', label: 'Codex', executable: true, installState: 'installed', runtimeState: 'ready', riskTier: 'low',
        capabilities: ['execute', 'stream_events'],
        reliability: {
          cliStatus: 'not_checked', authState: 'not_checked', quotaState: 'available', streamingMode: 'none',
          partialMessages: false, transcriptMode: 'final_text', toolSupport: 'read_only_cli_tools', mcpBridge: false,
        },
      } as unknown as Parameters<typeof buildEngineReliabilitySummary>[0]['descriptor'],
      needsWorkspace: false,
      sessionFailure: { category: 'auth', reason: 'token expired', suggestion: 'Sign in again', retryable: false, occurredAt: 0 } as unknown as Parameters<typeof buildEngineReliabilitySummary>[0]['sessionFailure'],
      now: 5 * 60_000,
      text,
    });
    expect(JSON.stringify(reliability)).not.toMatch(CJK);
    expect(reliability?.capabilityLine).toContain(text.engine.cli.not_checked);
    expect(reliability?.capabilityLine).toContain(text.engine.quota.available);
    expect(reliability?.capabilityLine).toContain(text.engine.auth.not_checked);
  });

  it.each(['native', 'codex'] as const)('localizes every %s trigger tooltip field label for the current language', async (kind) => {
    appState.modelConfig.provider = 'xiaomi';
    for (const language of ['en', 'zh'] as const) {
      ui.language = language;
      sessionState.sessions[0].engine.kind = kind;
      installDomainApi();
      render(<ModelSwitcher currentModel="mimo-v2.5-pro" />);
      const trigger = screen.getByRole('button', { name: (language === 'en' ? en : zh).settings.model.models.switcherPanel.triggerAria });
      const text = (language === 'en' ? en : zh).settings.model.models.switcherTooltip;
      await waitFor(() => expect(trigger.title).toContain(`${text.mainModel}: `));
      expect(trigger.title).toContain(`${text.engine}: `);
      if (language === 'en') {
        expect(trigger.title).not.toMatch(/[\u3400-\u9fff]/);
      } else {
        expect(trigger.title).not.toMatch(/\b(?:Engine|Provider|Effort|Thinking): /);
      }
      if (kind === 'native') {
        expect(trigger.title).toContain(`${text.billing}: ${text.billingModes.payg}`);
        expect(trigger.title).toContain(`${text.provider}: ${text.health.unknown}`);
        expect(trigger.title).toContain(`${text.effort}: ${text.effortLevels.high}`);
        expect(trigger.title).toContain(`${text.thinking}: ${text.thinkingOn}`);
      }
      cleanup();
    }
  });
});
