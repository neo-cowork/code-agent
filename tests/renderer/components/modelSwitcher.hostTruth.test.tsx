// @vitest-environment jsdom
// N-FIX-MODEL-PICKER-SHOWS-WRONG-MODEL：输入框模型名必须跟 host 实际调用的模型一致。

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n';
import { useStatusStore } from '../../../src/renderer/stores/statusStore';
import { resolveDisplayedModel } from '../../../src/renderer/components/StatusBar/sessionModelTruth';

const mocks = vi.hoisted(() => ({
  hostDefault: { provider: 'custom-team-relay', model: 'gpt-5.5' },
  hostOverride: null as null | { provider: string; model: string; adaptive?: boolean },
}));

const sessionState = {
  currentSessionId: 'session-1',
  sessions: [{ id: 'session-1', engine: { kind: 'native', permissionProfile: 'default', origin: 'manual' } }],
  updateSessionEngine: vi.fn(),
};

// 渲染层设置快照：故意与 host 不一致（快照是启动时拍的，云端下发等会在之后改 host 设置）。
const appState = {
  modelConfig: { provider: 'custom-team-relay', model: 'gpt-5.5' },
  workingDirectory: null,
  openSettingsTab: () => {},
};

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));

vi.mock('../../../src/renderer/stores/modeStore', () => {
  const modeState = {
    effortLevel: 'high', effortLevelExplicit: false, setEffortLevel: () => {}, setAutomaticEffortLevel: () => {},
    thinkingEnabled: true, setThinkingEnabled: () => {}, searchEnabled: true, setWebSearchEnabled: () => {},
  };
  return { useModeStore: (selector: (state: typeof modeState) => unknown) => selector(modeState) };
});

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh', setLanguage: () => {}, availableLanguages: [], getCloudString: () => undefined, cloudStrings: {} }),
}));

import { ModelSwitcher } from '../../../src/renderer/components/StatusBar/ModelSwitcher';

function Harness() {
  return <ModelSwitcher currentModel={appState.modelConfig.model} />;
}

const getModelOverride = vi.fn(async () => ({ success: true, data: mocks.hostOverride }));
// host 侧 getEffectiveModel = 运行循环同款解析（override > 默认含回落）
const getEffectiveModel = vi.fn(async () => ({ success: true, data: { ...(mocks.hostOverride ?? mocks.hostDefault), adaptive: false } }));

function installDomainApi(settings?: unknown) {
  const invoke = vi.fn(async (_domain: string, action: string) => {
    if (action === 'get' && settings) return { success: true, data: settings };
    if (action === 'getModelOverride') return getModelOverride();
    if (action === 'getEffectiveModel') return getEffectiveModel();
    if (action === 'listSources') return { success: true, data: [] };
    if (action === 'listModels') return { success: true, data: { catalog: null } };
    return { success: false, data: null };
  });
  Object.defineProperty(window, 'domainAPI', { configurable: true, value: { invoke } });
}

function decide(requested: [string, string], resolved: [string, string], reason: string) {
  act(() => {
    useStatusStore.getState().setLastModelDecision({
      sessionId: 'session-1',
      requestedProvider: requested[0], requestedModel: requested[1],
      resolvedProvider: resolved[0], resolvedModel: resolved[1],
      reason,
    });
  });
}

const trigger = () => screen.getByRole('button', { name: '切换模型' });

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  mocks.hostDefault = { provider: 'custom-team-relay', model: 'LongCat-2.0' };
  mocks.hostOverride = null;
  useStatusStore.getState().setLastModelDecision(null);
  getModelOverride.mockClear();
  getEffectiveModel.mockClear();
  installDomainApi();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).domainAPI;
});

describe('ModelSwitcher 显示 host 实际调用的模型', () => {
  it('loads provider names and duplicate source labels before the picker is ever opened', async () => {
    mocks.hostOverride = { provider: 'custom-tokenrhythm', model: 'mimo-v2.5-pro' };
    const settings = { models: { providers: {
      xiaomi: { enabled: true, apiKeyConfigured: true,
        models: { 'mimo-v2.5-pro': { enabled: true } } },
      'custom-tokenrhythm': { enabled: true, apiKeyConfigured: true, displayName: '基元',
        models: { 'mimo-v2.5-pro': { enabled: true } } },
    } } };
    const invoke = vi.fn(async (_domain: string, action: string) => {
      if (action === 'get') return { success: true, data: settings };
      if (action === 'getModelOverride') return getModelOverride();
      if (action === 'getEffectiveModel') return getEffectiveModel();
      return { success: false, data: null };
    });
    Object.defineProperty(window, 'domainAPI', { configurable: true, value: { invoke } });
    render(<Harness />);
    await waitFor(() => expect(trigger().title).toContain('基元/mimo-v2.5-pro'));
    expect(trigger().textContent).toBe('MiMo v2.5 Pro · 基元');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().title).not.toContain('custom-');
  });

  it('新会话、还没发消息：渲染层设置快照与 host 不一致（快照 gpt-5.5，host 说 LongCat-2.0）→ 输入框按 host 显示', async () => {
    render(<Harness />);
    await waitFor(() => expect(trigger().textContent).toMatch(/longcat/i));
    expect(trigger().textContent).not.toMatch(/gpt-5\.5/i);
  });

  it('渲染层默认被别的路径改了（首启引导/中转下发）：立刻重拉 host，不被旧缓存盖住', async () => {
    const view = render(<Harness />);
    await waitFor(() => expect(trigger().textContent).toMatch(/longcat/i));

    mocks.hostDefault = { provider: 'custom-tokenrhythm', model: 'mimo-v2.6-flash' };
    appState.modelConfig = { provider: 'custom-tokenrhythm', model: 'mimo-v2.6-flash' };
    view.rerender(<Harness />);

    await waitFor(() => expect(trigger().textContent).toMatch(/mimo v?-?2\.6/i));
    appState.modelConfig = { provider: 'custom-team-relay', model: 'gpt-5.5' };
  });

  it('host 默认后来又变了：下一轮决策到达后跟着变', async () => {
    render(<Harness />);
    await waitFor(() => expect(trigger().textContent).toMatch(/longcat/i));

    mocks.hostDefault = { provider: 'custom-tokenrhythm', model: 'mimo-v2.6-flash' };
    decide(['custom-tokenrhythm', 'mimo-v2.6-flash'], ['custom-tokenrhythm', 'mimo-v2.6-flash'], 'default-model');

    await waitFor(() => expect(trigger().textContent).toMatch(/mimo v?-?2\.6/i));
  });

  it('session/switchModel 接口在外部改成 mimo：决策到达后不再显示旧的 DeepSeek', async () => {
    mocks.hostOverride = { provider: 'deepseek', model: 'deepseek-v4-flash' };
    render(<Harness />);
    await waitFor(() => expect(trigger().textContent).toMatch(/deepseek/i));

    mocks.hostOverride = { provider: 'custom-tokenrhythm', model: 'mimo-v2.6-flash' };
    decide(['custom-tokenrhythm', 'mimo-v2.6-flash'], ['custom-tokenrhythm', 'mimo-v2.6-flash'], 'user-selected');

    await waitFor(() => expect(trigger().textContent).toMatch(/mimo v?-?2\.6/i));
    expect(trigger().textContent).not.toMatch(/deepseek/i);
  });

  it('外部改了会话模型、还没发消息：切回窗口（focus）也会重拉', async () => {
    mocks.hostOverride = { provider: 'deepseek', model: 'deepseek-v4-flash' };
    render(<Harness />);
    await waitFor(() => expect(trigger().textContent).toMatch(/deepseek/i));

    mocks.hostOverride = { provider: 'custom-tokenrhythm', model: 'mimo-v2.6-flash' };
    act(() => { window.dispatchEvent(new Event('focus')); });

    await waitFor(() => expect(trigger().textContent).toMatch(/mimo v?-?2\.6/i));
  });

  it('路由把模型换掉：显示真正在用的那个，并标「已换」+ 提示原来选的是谁', async () => {
    mocks.hostOverride = { provider: 'custom-tokenrhythm', model: 'mimo-v2.6-flash' };
    installDomainApi({ models: { providers: { 'custom-tokenrhythm': { enabled: true, apiKeyConfigured: true, displayName: '基元', models: { 'mimo-v2.6-flash': { enabled: true } } } } } });
    render(<Harness />);
    await waitFor(() => expect(trigger().textContent).toMatch(/mimo v?-?2\.6/i));

    decide(['custom-tokenrhythm', 'mimo-v2.6-flash'], ['zhipu', 'glm-5'], 'fallback-availability');

    await waitFor(() => expect(trigger().textContent).toContain('（已换）'));
    expect(trigger().textContent).toContain('GLM');
    expect(trigger().getAttribute('title')).toContain('你选的是 基元/mimo-v2.6-flash');
  });
});

describe('resolveDisplayedModel', () => {
  const selected = { provider: 'custom-tokenrhythm' as const, model: 'mimo-v2.6-flash' };
  const routed = {
    sessionId: 's1', requestedProvider: 'custom-tokenrhythm', requestedModel: 'mimo-v2.6-flash',
    resolvedProvider: 'zhipu', resolvedModel: 'glm-5', reason: 'strategy-fast',
  };

  it('别的会话的决策不影响当前会话', () => {
    expect(resolveDisplayedModel('s2', selected, routed)).toEqual({ ...selected, switchedFrom: null });
  });

  it('用户在决策之后又改了选择，以新选择为准', () => {
    const picked = { provider: 'deepseek' as const, model: 'deepseek-v4-pro' };
    expect(resolveDisplayedModel('s1', picked, routed)).toEqual({ ...picked, switchedFrom: null });
  });

  it('没换模型时就显示所选', () => {
    expect(resolveDisplayedModel('s1', selected, { ...routed, resolvedProvider: 'custom-tokenrhythm', resolvedModel: 'mimo-v2.6-flash' }))
      .toEqual({ ...selected, switchedFrom: null });
  });
});
