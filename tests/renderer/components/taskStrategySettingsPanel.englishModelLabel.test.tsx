// @vitest-environment jsdom
// 模型目录里有的模型名带中文后缀（「DeepSeek V4 Pro (推理)」）。任务模型下拉框里的名字
// 跟随界面语言：英文不含中文和中文标点，中文一字不动。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStrategySettingsPanel } from '../../../src/renderer/components/features/settings/tabs/TaskStrategySettingsPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { AppSettings, TaskModelStrategySettings } from '../../../src/shared/contract';
import { DEFAULT_MODELS } from '../../../src/shared/constants';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;

const strategy: TaskModelStrategySettings = {
  mode: 'auto',
  defaultProfile: 'main',
  profiles: {
    fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick, reasoningEffort: 'low', maxTokens: 4096 },
    main: { provider: 'deepseek', model: DEFAULT_MODELS.reasoning, reasoningEffort: 'medium', maxTokens: 16384 },
    deep: { provider: 'deepseek', model: DEFAULT_MODELS.reasoning, reasoningEffort: 'high', maxTokens: 32768 },
    vision: { provider: 'zhipu', model: DEFAULT_MODELS.vision, reasoningEffort: 'medium', maxTokens: 4096 },
  },
  fallback: { enabled: true, preferSameProvider: true, allowCrossProvider: true },
  rules: [],
};

const settings = {
  models: {
    default: 'deepseek',
    defaultProvider: 'deepseek',
    providers: {
      zhipu: { enabled: true, apiKeyConfigured: true },
      deepseek: { enabled: true, apiKeyConfigured: true },
    },
    routing: {
      code: { provider: 'deepseek', model: DEFAULT_MODELS.reasoning },
      vision: { provider: 'zhipu', model: DEFAULT_MODELS.vision },
      fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
      gui: { provider: 'zhipu', model: DEFAULT_MODELS.visionFast },
    },
    taskStrategy: strategy,
  },
} as unknown as AppSettings; // 面板只读 settings.models

function optionLabels(): string[] {
  const view = render(
    <TaskStrategySettingsPanel
      settings={settings}
      providerConfigs={settings.models.providers}
      defaultModel={{ provider: 'deepseek', model: DEFAULT_MODELS.reasoning }}
      config={{ provider: 'deepseek', model: DEFAULT_MODELS.reasoning }}
      strategy={strategy}
      onChange={vi.fn()}
      onMemoryRouteChange={vi.fn()}
    />,
  );
  return Array.from(view.container.querySelectorAll('option')).map((node) => node.textContent ?? '');
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe('任务模型下拉框里的模型名', () => {
  it('中文界面保留目录里的原名', () => {
    expect(optionLabels()).toContain('DeepSeek V4 Pro (推理)');
  });

  it('英文界面的模型名不含中文和中文标点', () => {
    useAppStore.setState({ language: 'en' });
    const labels = optionLabels();
    expect(labels).toContain('DeepSeek V4 Pro (Reasoning)');
    expect(labels.filter((label) => CJK.test(label))).toEqual([]);
  });
});
