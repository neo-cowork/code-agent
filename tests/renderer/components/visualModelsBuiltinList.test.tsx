// BuiltinModelList 渲染回归（多模态桥接 P1 Task 6 frontend）：
// 桥接行渲染「来自 {sourceLabel}」徽标；read-only 模式（生音乐段）不渲染默认选择 radio；
// available=false 行渲染未配置徽标。用 renderToStaticMarkup（node 环境，无 jsdom）。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../../src/shared/contract';
import { deriveBridgedVisualModels } from '../../../src/shared/visualModelBridge';
import { BuiltinModelList, type BuiltinRow } from '../../../src/renderer/components/features/settings/tabs/VisualModelsSettings';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const s = zh.settings.visualModels;
const cm = zh.design.customModel;
const noop = () => undefined;

const rows: BuiltinRow[] = [
  { id: 'minimax-music-2.6', label: 'MiniMax 音乐', provider: 'minimax', available: true, source: 'builtin' },
  { id: 'bridged-x', label: '桥接音乐', provider: 'deepseek', available: false, source: 'bridged', sourceLabel: 'DeepSeek' },
];

const selectedRows: BuiltinRow[] = [
  { id: 'image-a', label: 'Image A', provider: 'test', available: true, source: 'builtin' },
  { id: 'image-b', label: 'Image B', provider: 'test', available: true, source: 'builtin' },
];

function render(readOnly: boolean): string {
  return renderToStaticMarkup(
    <BuiltinModelList
      title={s.builtinTitle}
      hint={s.defaultHint}
      rows={rows}
      availableBadge={cm.availableBadge}
      unconfiguredBadge={cm.unconfiguredBadge}
      defaultBadge={s.defaultBadge}
      bridgedFromBadge={s.bridgedFromBadge}
      manageButton={cm.manage}
      configureButton={s.configureButton}
      onConfigure={noop}
      readOnly={readOnly}
    />,
  );
}

describe('BuiltinModelList 桥接 + 只读渲染', () => {
  it('桥接行渲染「来自 {sourceLabel}」徽标', () => {
    const html = render(true);
    expect(html).toContain(s.bridgedFromBadge.replace('{name}', 'DeepSeek'));
  });

  it('available=false 行渲染未配置徽标，available=true 渲染已配置徽标', () => {
    const html = render(true);
    expect(html).toContain(cm.unconfiguredBadge);
    expect(html).toContain(cm.availableBadge);
  });

  it('read-only 模式（生音乐段）不渲染默认选择 radio', () => {
    expect(render(true)).not.toContain('type="radio"');
  });

  it('非只读模式渲染默认选择 radio', () => {
    expect(render(false)).toContain('type="radio"');
  });

  it('只给当前默认模型绘制一个选中圆心', () => {
    const html = renderToStaticMarkup(
      <BuiltinModelList
        title={s.builtinTitle}
        hint={s.defaultHint}
        rows={selectedRows}
        availableBadge={cm.availableBadge}
        unconfiguredBadge={cm.unconfiguredBadge}
        defaultBadge={s.defaultBadge}
        bridgedFromBadge={s.bridgedFromBadge}
        manageButton={cm.manage}
        configureButton={s.configureButton}
        selectedId="image-a"
        groupName="visual-test"
        onSelect={noop}
        onConfigure={noop}
      />,
    );
    expect(html.match(/data-visual-model-radio-state="selected"/g) || []).toHaveLength(1);
    expect(html.match(/data-visual-model-radio-state="unselected"/g) || []).toHaveLength(1);
  });

  it('未命名动态 custom-provider-2 桥接徽标按中英文落本地化名，已命名服务商保持不变', () => {
    const bridgedSettings = {
      models: {
        default: 'custom-provider-2',
        providers: {
          'custom-provider-2': {
            enabled: true,
            apiKeyConfigured: true,
            models: {
              'poster-image-v1': { label: 'Poster Image v1', enabled: true, capabilities: ['imageGen'] },
            },
          },
          'custom-provider-3': {
            enabled: true,
            apiKeyConfigured: true,
            displayName: '财务部模型',
            models: {
              'finance-chart-image': { label: 'Finance Chart Image', enabled: true, capabilities: ['imageGen'] },
            },
          },
        },
      },
    } as unknown as AppSettings;

    const bridgedRows: BuiltinRow[] = deriveBridgedVisualModels(bridgedSettings).map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.sourceProvider,
      available: true,
      source: 'bridged',
      sourceLabel: m.sourceLabel,
    }));

    const zhHtml = renderToStaticMarkup(
      <BuiltinModelList
        title={zh.settings.visualModels.builtinTitle}
        hint={zh.settings.visualModels.defaultHint}
        rows={bridgedRows}
        availableBadge={zh.design.customModel.availableBadge}
        unconfiguredBadge={zh.design.customModel.unconfiguredBadge}
        defaultBadge={zh.settings.visualModels.defaultBadge}
        bridgedFromBadge={zh.settings.visualModels.bridgedFromBadge}
        manageButton={zh.design.customModel.manage}
        configureButton={zh.settings.visualModels.configureButton}
        onConfigure={noop}
        language="zh"
      />,
    );
    const zhText = zhHtml.replace(/<[^>]+>/g, ' ');
    expect(zhText).toContain('来自 自定义模型服务 2');
    expect(zhText).toContain('来自 财务部模型');
    expect(zhText).not.toMatch(/custom-/i);
    expect(zhText).not.toContain('Provider 2');

    const enHtml = renderToStaticMarkup(
      <BuiltinModelList
        title={en.settings.visualModels.builtinTitle}
        hint={en.settings.visualModels.defaultHint}
        rows={bridgedRows}
        availableBadge={en.design.customModel.availableBadge}
        unconfiguredBadge={en.design.customModel.unconfiguredBadge}
        defaultBadge={en.settings.visualModels.defaultBadge}
        bridgedFromBadge={en.settings.visualModels.bridgedFromBadge}
        manageButton={en.design.customModel.manage}
        configureButton={en.settings.visualModels.configureButton}
        onConfigure={noop}
        language="en"
      />,
    );
    const enText = enHtml.replace(/<[^>]+>/g, ' ');
    expect(enText).toContain('from Custom provider 2');
    expect(enText).toContain('from 财务部模型');
    expect(enText).not.toMatch(/custom-/i);
    expect(enText).not.toContain('Provider 2');
  });
});
