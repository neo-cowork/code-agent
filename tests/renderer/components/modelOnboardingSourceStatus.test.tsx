// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEngineSourceDescriptor } from '../../../src/shared/contract/agentEngine';

const appState = {
  modelConfig: { provider: 'deepseek', model: 'deepseek-chat', apiKey: '', baseUrl: 'https://api.deepseek.com' },
  workingDirectory: '/workspace' as string | undefined,
  language: 'zh' as 'zh' | 'en',
  setLanguage: vi.fn(),
  cloudUIStrings: null,
};
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => selector ? selector(appState) : appState,
}));

const sessionState = {
  currentSessionId: 'session-1',
  sessions: [{ id: 'session-1', workingDirectory: '/workspace', engine: { kind: 'native' } }],
  updateSessionEngine: vi.fn(),
};
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));

function source(manifestId: string, overrides: Partial<AgentEngineSourceDescriptor>): AgentEngineSourceDescriptor {
  return {
    manifestId,
    label: `Tool ${manifestId.slice(0, 3)}`,
    summary: 'fixture',
    detected: false,
    selectable: false,
    authState: 'not_checked',
    modelSelection: 'runtime_catalog',
    evidence: 'production',
    credentialOwner: 'official_client',
    auditNotes: [],
    ...overrides,
  };
}

// 11 种状态，每种一张卡。id 即状态名；推荐兜底三家用真实 manifestId（语言包按它取文案）。
const STATES: AgentEngineSourceDescriptor[] = [
  source('s01_selectable', { detected: true, selectable: true, authState: 'authenticated', version: '1.0.0' }),
  source('s02_probe_error', { detected: true, probeError: 'spawn failed', evidence: 'production' }),
  source('s03_detected_unverified_needs_login', { detected: true, evidence: 'local_spike', authState: 'needs_login' }),
  source('s04_detected_local_spike', { detected: true, evidence: 'local_spike' }),
  source('s05_detected_unverified', { detected: true, evidence: 'none' }),
  source('s06_detected_production_needs_login', { detected: true, evidence: 'production', authState: 'needs_login' }),
  source('s07_detected_production_auth_unknown', { detected: true, evidence: 'production', authState: 'unknown' }),
  source('s08_not_detected_production', { detected: false, evidence: 'production' }),
  source('s09_not_detected_local_spike', { detected: false, evidence: 'local_spike' }),
  source('qoder_work', { detected: false, evidence: 'none' }),
  source('comate_zulu', { detected: false, evidence: 'none' }),
  source('cursor_cli', { detected: false, evidence: 'none' }),
];

const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args) },
}));

import { ModelOnboardingModal } from '../../../src/renderer/components/onboarding/ModelOnboardingModal';

const BANNED: Record<'zh' | 'en', RegExp> = {
  zh: /Adapter|Spike|门禁|生产|Manifest|codec|协议|事件流|模型目录|探测|CLI/i,
  en: /adapter|spike|gate|manifest|codec|protocol|live events|catalog|local support|production/i,
};

beforeEach(() => {
  invokeDomain.mockReset();
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'listSources') return Promise.resolve(STATES);
    if (action === 'listModels') return Promise.resolve({ catalog: { version: 'f', updatedAt: '', engines: [] }, source: 'local_discovery', diagnostics: [] });
    return Promise.resolve({});
  });
});

afterEach(cleanup);

async function renderStates(language: 'zh' | 'en') {
  appState.language = language;
  render(<ModelOnboardingModal onComplete={vi.fn()} onSkip={vi.fn()} />);
  const section = await screen.findByTestId('onboarding-subscription-sources');
  const dialog = screen.getByRole('dialog');
  const cards = STATES.map((state) => {
    const card = dialog.querySelector(
      `[data-onboarding-engine="${state.manifestId}"], [data-onboarding-engine-status="${state.manifestId}"]`,
    );
    expect(card, state.manifestId).toBeTruthy();
    const spans = card!.querySelectorAll('span');
    return {
      id: state.manifestId,
      detail: card!.querySelector('span.block.truncate')!.textContent ?? '',
      badge: spans[spans.length - 1].textContent ?? '',
    };
  });
  return { dialog, section, cards };
}

function partition(cards: { id: string; detail: string; badge: string }[], key: 'detail' | 'badge') {
  const groups = new Map<string, string[]>();
  for (const card of cards) groups.set(card[key], [...(groups.get(card[key]) ?? []), card.id]);
  return [...groups.values()].map((ids) => ids.join(',')).sort();
}

describe('first-run wizard source status copy', () => {
  it.each(['zh', 'en'] as const)('renders all 11 source states in %s without internal jargon', async (language) => {
    const { dialog, cards } = await renderStates(language);

    expect(cards).toHaveLength(STATES.length);
    for (const card of cards) {
      expect(card.detail.trim(), card.id).not.toBe('');
      expect(card.badge.trim(), card.id).not.toBe('');
    }
    expect(dialog.textContent?.match(BANNED[language])?.[0]).toBeUndefined();
    if (language === 'en') expect(dialog.textContent).not.toMatch(/[㐀-鿿]/u);
  });

  it('maps the same states to the same badges and statuses in zh and en', async () => {
    const zh = await renderStates('zh');
    const zhCards = zh.cards;
    cleanup();
    const en = await renderStates('en');

    expect(partition(en.cards, 'badge')).toEqual(partition(zhCards, 'badge'));
    expect(partition(en.cards, 'detail')).toEqual(partition(zhCards, 'detail'));
    // 抽查含义：可用卡与未登录卡必须是不同徽标
    expect(zhCards[0].badge).not.toBe(zhCards[2].badge);
    expect(en.cards[0].badge).not.toBe(en.cards[2].badge);
  });
});
