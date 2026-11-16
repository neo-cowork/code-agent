// @vitest-environment jsdom

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEngineModelCatalog, AgentEngineSourceDescriptor } from '../../../src/shared/contract/agentEngine';
import { listExternalEngineManifests } from '../../../src/shared/externalEngineManifest';
import { EngineScopedModelPanel, filterEngineSources } from '../../../src/renderer/components/StatusBar/EngineScopedModelPanel';
import { languages } from '../../../src/renderer/i18n';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { getEngineSummary } from '../../../src/renderer/utils/engineManifestCopy';

const HAN = /[㐀-䶿一-鿿豈-﫿]/u;
const noop = () => undefined;
const catalog: AgentEngineModelCatalog = { version: 'fixture', updatedAt: '2026-11-15T00:00:00.000Z', engines: [] };

// 来源直接取真实的引擎清单（中文简介 + 中文推荐语），覆盖面板里每一种状态文案
const states: Array<Partial<AgentEngineSourceDescriptor>> = [
  { detected: true, selectable: true, authState: 'authenticated', evidence: 'production' },
  { detected: true, selectable: false, authState: 'needs_login', evidence: 'production' },
  { detected: true, selectable: false, authState: 'not_checked', evidence: 'production' },
  { detected: true, selectable: false, authState: 'unknown', evidence: 'local_spike' },
  { detected: false, selectable: false, authState: 'not_checked', evidence: 'none' },
];
const sources: AgentEngineSourceDescriptor[] = listExternalEngineManifests().map((manifest, index) => ({
  manifestId: manifest.id,
  ...(manifest.kind ? { kind: manifest.kind } : {}),
  label: manifest.label,
  summary: manifest.summary,
  modelSelection: manifest.modelSelection,
  credentialOwner: manifest.adapter.credentialOwner,
  auditNotes: [],
  ...(manifest.recommendation ? { recommendation: manifest.recommendation } : {}),
  ...states[index % states.length],
} as AgentEngineSourceDescriptor));

function readable(root: HTMLElement): string {
  const attrs = [...root.querySelectorAll('*')].flatMap((el) =>
    ['placeholder', 'aria-label', 'title', 'alt'].map((name) => el.getAttribute(name) ?? ''));
  return `${root.textContent ?? ''} ${attrs.join(' ')}`;
}

function renderPanel(view: 'engines' | 'models') {
  return render(
    <EngineScopedModelPanel
      view={view}
      sources={sources}
      catalog={catalog}
      currentEngine="native"
      query=""
      onQueryChange={noop}
      onViewChange={noop}
      onSelectEngine={noop}
      onSelectExternalModel={noop}
      onOpenSettings={noop}
      onRetryCatalog={noop}
    />,
  );
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe('执行引擎选择面板跟随界面语言（FB-1282）', () => {
  it('英文界面：引擎列表和模型视图都没有中文', () => {
    useAppStore.setState({ language: 'en' });
    const engines = renderPanel('engines');
    expect(engines.container.textContent).toContain('Choose an engine');
    expect(engines.container.textContent).toContain('Found, sign-in needed');
    expect(readable(engines.container)).not.toMatch(HAN);
    cleanup();
    const models = renderPanel('models');
    expect(models.container.textContent).toContain('Provider models');
    expect(readable(models.container)).not.toMatch(HAN);
  });

  it('中文界面：面板文案与改动前逐字相同', () => {
    const copy = languages.zh.engineModelPanel;
    expect([
      copy.backToModels, copy.pickEngineTitle, copy.pickEngineHint, copy.openEngineSettingsAria, copy.engineSettingsTitle,
      copy.searchEnginePlaceholder, copy.detectingEngines, copy.noMatchingEngine, copy.stateReady, copy.stateNotDetected,
      copy.stateNeedsLogin, copy.stateLoginUnverified, copy.stateAdapterClosed, copy.stateUnavailable, copy.providerModels,
      copy.goToSettings, copy.switchEngine,
    ]).toEqual([
      '返回模型', '选择执行引擎', '先选引擎，再选择它真实可用的模型', '打开执行引擎设置', '执行引擎设置',
      '搜索执行引擎…', '正在检测本机可用的执行引擎…', '无匹配引擎', '已检测，可用', '未检测',
      '已检测，需要登录', '已检测，登录状态未验证', '已检测，适配器未开放', '暂不可用', 'Provider 模型',
      '去设置', '切换引擎',
    ]);
    const engines = renderPanel('engines');
    for (const text of ['选择执行引擎', '先选引擎，再选择它真实可用的模型', '已检测，可用', '已检测，需要登录']) {
      expect(engines.container.textContent).toContain(text);
    }
  });

  it('搜索按界面上看到的简介匹配：英文界面搜英文简介里的词能找到', () => {
    const summaryOf = (source: AgentEngineSourceDescriptor) => getEngineSummary(source, languages.en.engineManifest);
    expect(filterEngineSources(sources, 'headless', summaryOf).map((source) => source.manifestId)).toEqual(['dsh_cli']);
  });
});
