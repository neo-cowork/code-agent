// @vitest-environment jsdom
// ============================================================================
// V4 记忆整理模型「跟随快速模型」可恢复：
// 1. Select 含「跟随快速模型（默认）」选项
// 2. 已单独配置时选中该选项 → onMemoryRouteChange(null)（清除 routing.memory 覆盖）
// ============================================================================

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TaskStrategySettingsPanel } from '../../../src/renderer/components/features/settings/tabs/TaskStrategySettingsPanel';
import type { AppSettings, TaskModelStrategySettings } from '../../../src/shared/contract';
import { DEFAULT_MODELS, PROVIDER_MODELS } from '../../../src/shared/constants';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const strategy: TaskModelStrategySettings = {
  mode: 'auto',
  defaultProfile: 'main',
  profiles: {
    fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick, reasoningEffort: 'low', maxTokens: 4096 },
    main: { provider: 'xiaomi', model: DEFAULT_MODELS.chat, reasoningEffort: 'medium', maxTokens: 16384 },
    deep: { provider: 'deepseek', model: DEFAULT_MODELS.reasoning, reasoningEffort: 'high', maxTokens: 32768 },
    vision: { provider: 'xiaomi', model: DEFAULT_MODELS.vision, reasoningEffort: 'medium', maxTokens: 4096 },
  },
  fallback: {
    enabled: true,
    preferSameProvider: true,
    allowCrossProvider: true,
  },
  rules: [],
};

function buildSettings(memoryRoute: { provider: 'deepseek' | 'zhipu'; model: string } | null): AppSettings {
  return {
    models: {
      default: 'xiaomi',
      defaultProvider: 'xiaomi',
      providers: {
        xiaomi: { enabled: true, apiKeyConfigured: true },
        zhipu: { enabled: true, apiKeyConfigured: true },
        deepseek: { enabled: true, apiKeyConfigured: true },
      },
      routing: {
        code: { provider: 'xiaomi', model: DEFAULT_MODELS.code },
        vision: { provider: 'xiaomi', model: DEFAULT_MODELS.vision },
        fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
        gui: { provider: 'zhipu', model: DEFAULT_MODELS.visionFast },
        ...(memoryRoute ? { memory: memoryRoute } : {}),
      },
      taskStrategy: strategy,
    },
  } as unknown as AppSettings; // 面板只读 settings.models，其余 AppSettings 顶层字段本用例不需要
}

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

describe('TaskStrategySettingsPanel 记忆整理模型跟随快速模型', () => {
  it('未配置 routing.memory 时 Select 选中「跟随快速模型（默认）」', () => {
    const settings = buildSettings(null);
    render(
      <TaskStrategySettingsPanel
        settings={settings}
        providerConfigs={settings.models.providers}
        defaultModel={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        config={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        strategy={strategy}
        onChange={vi.fn()}
        onMemoryRouteChange={vi.fn()}
      />,
    );

    const select = screen.getByLabelText('记忆整理模型') as HTMLSelectElement;
    expect(select.value).toBe('__follow_fast__');
    expect(screen.getByText('跟随快速模型（默认）')).toBeTruthy();
  });

  it('已配置 routing.memory 时选「跟随快速模型」→ onMemoryRouteChange(null)', () => {
    const settings = buildSettings({ provider: 'deepseek', model: DEFAULT_MODELS.reasoning });
    const onMemoryRouteChange = vi.fn();
    render(
      <TaskStrategySettingsPanel
        settings={settings}
        providerConfigs={settings.models.providers}
        defaultModel={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        config={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        strategy={strategy}
        onChange={vi.fn()}
        onMemoryRouteChange={onMemoryRouteChange}
      />,
    );

    const select = screen.getByLabelText('记忆整理模型') as HTMLSelectElement;
    expect(select.value).toBe(`deepseek:::${DEFAULT_MODELS.reasoning}`);

    fireEvent.change(select, { target: { value: '__follow_fast__' } });
    expect(onMemoryRouteChange).toHaveBeenCalledWith(null);
  });

  it('routing.memory 指向不在可选列表的组合（FB-195 zhipu/DeepSeek-V4-Flash-0731）→ 说明原因并一键回到跟随快速模型', () => {
    const settings = buildSettings({ provider: 'zhipu', model: 'DeepSeek-V4-Flash-0731' });
    const onMemoryRouteChange = vi.fn();
    render(
      <TaskStrategySettingsPanel
        settings={settings}
        providerConfigs={settings.models.providers}
        defaultModel={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        config={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        strategy={strategy}
        onChange={vi.fn()}
        onMemoryRouteChange={onMemoryRouteChange}
      />,
    );

    expect((screen.getByLabelText('记忆整理模型') as HTMLSelectElement).value).toBe('zhipu:::DeepSeek-V4-Flash-0731');
    const warning = screen.getByTestId('memory-route-unavailable');
    expect(warning.textContent).toContain('不在已启用的模型列表里');
    fireEvent.click(screen.getByRole('button', { name: '改为跟随快速模型' }));
    expect(onMemoryRouteChange).toHaveBeenCalledWith(null);
  });

  it('routing.memory 可用时不出不可用提示', () => {
    const settings = buildSettings({ provider: 'deepseek', model: DEFAULT_MODELS.reasoning });
    render(
      <TaskStrategySettingsPanel
        settings={settings}
        providerConfigs={settings.models.providers}
        defaultModel={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        config={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        strategy={strategy}
        onChange={vi.fn()}
        onMemoryRouteChange={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('memory-route-unavailable')).toBeNull();
  });
});

describe('TaskStrategySettingsPanel 任务主模型', () => {
  it('任务主模型指向不可用模型时标「不可用」、不自愈改写', () => {
    const settings = buildSettings(null);
    const onChange = vi.fn();
    const brokenMain = { ...strategy, profiles: { ...strategy.profiles, main: { ...strategy.profiles.main, provider: 'openai' as const, model: 'gone-model' } } };
    render(
      <TaskStrategySettingsPanel
        settings={settings}
        providerConfigs={settings.models.providers}
        defaultModel={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        config={{ provider: 'zhipu', model: DEFAULT_MODELS.quick }}
        strategy={brokenMain}
        onChange={onChange}
        onMemoryRouteChange={vi.fn()}
      />,
    );

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('不可用')).toBeTruthy();
    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('openai:::gone-model');
  });

  it('同为 GLM 家族的中转来源（GLM Coding Plan）不被去重误判不可用，也不被自愈改写（FB-195：Dev 槽快速/深度被改成 LongCat）', () => {
    const settings = buildSettings(null);
    const providers = {
      ...settings.models.providers,
      // zhipu updatedAt 更新 → 对话切换器的家族去重只留 zhipu，GLM Coding Plan 整组被丢
      zhipu: { enabled: true, apiKeyConfigured: true, updatedAt: 1782787397380 },
      'custom-glm-coding': {
        enabled: true,
        apiKeyConfigured: true,
        displayName: 'GLM Coding Plan',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        protocol: 'openai',
        model: 'glm-5.3-flash',
        models: { 'glm-5.3-flash': { enabled: true, label: 'GLM-5.3 Flash', capabilities: ['general', 'code', 'fast'] } },
      },
    } as unknown as AppSettings['models']['providers'];
    const glmStrategy = {
      ...strategy,
      profiles: {
        ...strategy.profiles,
        main: { ...strategy.profiles.main, provider: 'custom-glm-coding' as const, model: 'glm-5.3-flash' },
        fast: { ...strategy.profiles.fast, provider: 'custom-glm-coding' as const, model: 'glm-5.3-flash' },
      },
    };
    const onChange = vi.fn();
    render(
      <TaskStrategySettingsPanel
        settings={{ ...settings, models: { ...settings.models, providers } }}
        providerConfigs={providers}
        defaultModel={{ provider: 'xiaomi', model: DEFAULT_MODELS.chat }}
        config={{ provider: 'zhipu', model: DEFAULT_MODELS.quick }}
        strategy={glmStrategy}
        onChange={onChange}
        onMemoryRouteChange={vi.fn()}
      />,
    );

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText('不可用')).toBeNull();
    const fastSelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
    expect([...fastSelect.options].map((option) => option.value)).toContain('custom-glm-coding:::glm-5.3-flash');
  });
});


describe('TaskStrategySettingsPanel display exemptions do not authorize self-healing', () => {
  const savedDefault = { provider: 'xiaomi' as const, model: PROVIDER_MODELS.find(p => p.id === 'xiaomi')!.models[0].id };
  const relayDefault = { provider: 'xiaomi' as const, model: 'neohorse-1.5-flash-preview' };
  const missing = { provider: 'openai' as const, model: 'gone-fast-model' };

  it.each([
    ['undiscovered Local', { provider: 'local' as const, model: 'undiscovered-local-model' }],
    ['provider with every model disabled', savedDefault],
    ['disabled last custom model', { provider: 'custom-last' as const, model: 'last-custom-model' }],
  ])('does not persist an invalid fallback when browsing %s', (_label, browsed) => {
    const settings = buildSettings(null);
    const providers = {
      ...settings.models.providers,
      local: { enabled: true, available: true, models: {} },
      ...(browsed.provider === 'xiaomi' ? { xiaomi: {
        enabled: true, apiKeyConfigured: true,
        models: Object.fromEntries(PROVIDER_MODELS.find(p => p.id === 'xiaomi')!.models.map(m => [m.id, { enabled: false }])),
      } } : {}),
      'custom-last': { enabled: true, apiKeyConfigured: true, protocol: 'openai' as const,
        model: 'last-custom-model', models: { 'last-custom-model': { enabled: false } } },
    };
    const selectedSettings = { ...settings, models: { ...settings.models, providers, routing: { ...settings.models.routing, memory: browsed } } };
    const selectedStrategy = { ...strategy, profiles: { ...strategy.profiles, main: { ...strategy.profiles.main, ...browsed }, fast: { ...strategy.profiles.fast, ...missing } } };
    const onChange = vi.fn();
    const props = { settings: selectedSettings, providerConfigs: providers, strategy: selectedStrategy,
      defaultModel: savedDefault, onChange, onMemoryRouteChange: vi.fn() };
    // Rerender models selecting a provider or disabling its final model.
    const { rerender } = render(<TaskStrategySettingsPanel {...props} config={{ provider: 'local', model: 'not-discovered' }} />);
    onChange.mockClear();
    rerender(<TaskStrategySettingsPanel {...props} config={browsed} />);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('memory-route-unavailable')).toBeTruthy();
    const main = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(main.selectedOptions[0].textContent).toContain('（不可用）');
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('openai:::gone-fast-model');
  });

  it('keeps the saved relay default visible while browsing a different unavailable provider', () => {
    const settings = buildSettings(null);
    const selectedSettings = { ...settings, models: { ...settings.models, routing: { ...settings.models.routing, memory: relayDefault } } };
    const selectedStrategy = { ...strategy, profiles: Object.fromEntries(Object.entries(strategy.profiles).map(([id, slot]) => [id, { ...slot, ...relayDefault }])) as TaskModelStrategySettings['profiles'] };
    const onChange = vi.fn();
    render(<TaskStrategySettingsPanel settings={selectedSettings} providerConfigs={settings.models.providers}
      defaultModel={relayDefault} config={{ provider: 'local', model: 'not-discovered' }}
      strategy={selectedStrategy} onChange={onChange} onMemoryRouteChange={vi.fn()} />);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText('不可用')).toBeNull();
    expect(screen.queryByTestId('memory-route-unavailable')).toBeNull();
    expect((screen.getByLabelText('记忆整理模型') as HTMLSelectElement).selectedOptions[0].textContent).toBe('xiaomi/neohorse-1.5-flash-preview');
  });

  it('keeps an undiscovered saved Local default unavailable even when another local model was discovered', () => {
    const settings = buildSettings(null);
    const localDefault = { provider: 'local' as const, model: 'not-discovered' };
    const providers = { ...settings.models.providers, local: { enabled: true, available: true,
      models: { 'discovered-local-model': { enabled: true, discoveredAt: 1 } } } };
    const selectedSettings = { ...settings, models: { ...settings.models, providers, routing: { ...settings.models.routing, memory: localDefault } } };
    const selectedStrategy = { ...strategy, profiles: { ...strategy.profiles,
      main: { ...strategy.profiles.main, ...localDefault }, fast: { ...strategy.profiles.fast, ...missing } } };
    const onChange = vi.fn();
    render(<TaskStrategySettingsPanel settings={selectedSettings} providerConfigs={providers}
      defaultModel={localDefault} config={localDefault} strategy={selectedStrategy}
      onChange={onChange} onMemoryRouteChange={vi.fn()} />);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('memory-route-unavailable')).toBeTruthy();
    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).selectedOptions[0].textContent).toContain('（不可用）');
  });

  it('does not use a display-only relay default as an automatic fallback', () => {
    const settings = buildSettings(null);
    const selectedStrategy = { ...strategy, profiles: { ...strategy.profiles, fast: { ...strategy.profiles.fast, ...missing } } };
    const onChange = vi.fn();
    render(<TaskStrategySettingsPanel settings={settings} providerConfigs={settings.models.providers}
      defaultModel={relayDefault} config={relayDefault} strategy={selectedStrategy}
      onChange={onChange} onMemoryRouteChange={vi.fn()} />);
    expect(onChange).not.toHaveBeenCalled();
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).selectedOptions[0].textContent).toContain('（不可用）');
  });

  it('still self-heals to a model in the unmodified runtime options', () => {
    const settings = buildSettings(null);
    const selectedStrategy = { ...strategy, profiles: { ...strategy.profiles, fast: { ...strategy.profiles.fast, ...missing } } };
    const onChange = vi.fn();
    render(<TaskStrategySettingsPanel settings={settings} providerConfigs={settings.models.providers}
      defaultModel={savedDefault} config={savedDefault} strategy={selectedStrategy}
      onChange={onChange} onMemoryRouteChange={vi.fn()} />);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...selectedStrategy, profiles: {
      ...selectedStrategy.profiles, fast: { ...selectedStrategy.profiles.fast, ...savedDefault },
    } });
  });
});
