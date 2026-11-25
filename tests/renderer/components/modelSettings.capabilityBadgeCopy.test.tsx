// @vitest-environment jsdom
// ============================================================================
// Settings → Models 模型行：能力徽章与「最大输出」列头走 i18n。
// 徽章文字只允许查 switcherPanel.capabilities 表——没登记的 feature id
// 一个 chip 都不渲染，绝不把原始英文 id 露给用户。
// ============================================================================

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/modelRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/modelRuntime')>();
  return { ...actual, featuresFromModelMetadata: vi.fn(actual.featuresFromModelMetadata) };
});

import { featuresFromModelMetadata, type RuntimeModelFeature, type RuntimeProviderModel } from '@shared/modelRuntime';
import { ProviderModelsSection } from '../../../src/renderer/components/features/settings/tabs/ProviderModelsSection';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const model: RuntimeProviderModel = {
  id: 'kimi-k2.5',
  label: 'Kimi K2.5',
  enabled: true,
  capabilities: ['vision', 'reasoning'],
  supportsTool: true,
  supportsVision: true,
  supportsStreaming: true,
  source: 'catalog',
};

function renderSection() {
  return render(
    <ProviderModelsSection
      hasApiKey={true}
      provider="moonshot"
      currentModels={[model]}
      currentEnabledModels={[model]}
      filteredCurrentModels={[model]}
      effectiveBaseUrl="https://api.moonshot.cn"
      isDiscovering={false}
      onDiscoverModels={vi.fn()}
      modelSearch=""
      onModelSearchChange={vi.fn()}
      manualModelId=""
      onManualModelIdChange={vi.fn()}
      manualModelLabel=""
      onManualModelLabelChange={vi.fn()}
      onAddManualModel={vi.fn()}
      defaultSelection={{ provider: 'moonshot', model: 'some-other-model' }}
      settingDefaultModelId={null}
      onSetDefaultModel={vi.fn()}
      onToggleModelEnabled={vi.fn()}
      onThinkingChange={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe('model list capability badge copy', () => {
  beforeEach(() => useAppStore.setState({ language: 'zh' }));

  it('中文界面：徽章用中文词、最大输出列头是中文，不露原始 feature id', () => {
    const view = renderSection();
    expect(view.getByText('工具调用')).toBeTruthy();
    expect(view.getByText('识图')).toBeTruthy();
    expect(view.getByText('深度思考')).toBeTruthy();
    expect(view.getByText('最大输出')).toBeTruthy();
    for (const raw of ['tool', 'vision', 'reasoning', 'Max Output']) {
      expect(view.queryByText(raw)).toBeNull();
    }
  });

  it('英文界面：徽章用英文词、最大输出列头是英文', () => {
    useAppStore.setState({ language: 'en' });
    const view = renderSection();
    expect(view.getByText('Tool calling')).toBeTruthy();
    expect(view.getByText('Vision')).toBeTruthy();
    expect(view.getByText('Reasoning')).toBeTruthy();
    expect(view.getByText('Max output')).toBeTruthy();
    for (const zh of ['工具调用', '识图', '深度思考', '最大输出']) {
      expect(view.queryByText(zh)).toBeNull();
    }
  });

  it('未在 i18n 表登记的 feature id：不渲染 chip、不露原始 id', () => {
    vi.mocked(featuresFromModelMetadata).mockReturnValueOnce([
      'tool',
      'quantumLeap' as RuntimeModelFeature,
    ]);
    const view = renderSection();
    expect(view.getByText('工具调用')).toBeTruthy();
    expect(view.queryByText('quantumLeap')).toBeNull();
  });
});
