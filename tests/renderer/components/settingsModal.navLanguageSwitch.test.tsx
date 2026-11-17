// @vitest-environment jsdom
// ============================================================================
// 设置左侧导航随 UI 语言原地换标签：渲染一次 SettingsModal，不重挂载，
// en → zh → en 切换后每个 tab label / 组标题都必须跟着换（防「半中半英」导航）。
// 兜底有人把 buildSettingsTabGroups 的结果缓存成只算一次。
// ============================================================================
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('../../../src/renderer/components/features/settings/SettingsSearch', () => ({
  SettingsSearch: () => null,
}));
vi.mock('../../../src/renderer/slots/productSlotHosts', () => ({
  SettingsSectionSlotHost: () => null,
}));
vi.mock('../../../src/renderer/components/composites/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));
vi.mock('../../../src/renderer/components/UpdateNotification', () => ({
  UpdateNotification: () => null,
}));
vi.mock('../../../src/renderer/components/features/settings/tabs/ModelSettings', () => ({
  ModelSettings: () => <div data-testid="stub-model-settings" />,
}));

import {
  SettingsModal,
  buildSettingsTabGroups,
} from '../../../src/renderer/components/features/settings/SettingsModal';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { isDesktopShellMode } from '../../../src/renderer/utils/platform';
import { COLLAPSED_SETTINGS_TAB_GROUPS } from '../../../src/renderer/utils/settingsTabs';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

type Dict = typeof en;

function expectedLabel(dict: Dict, id: string): string {
  if (id === 'agentEngine') return dict.engineCompat.engineSection.title;
  return (dict.settings.tabs as Record<string, string>)[id];
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh', settingsInitialTab: null });
});

describe('SettingsModal 导航随 UI 语言原地切换', () => {
  it('en → zh → en 不重挂载，全部 tab label 与组标题跟随语言', () => {
    useAppStore.setState({ language: 'en', settingsInitialTab: 'model' });
    render(<SettingsModal />);

    // 与组件同入参（未登录、无已装能力），期望 id 列表跟随真实 tab 集合
    const groups = buildSettingsTabGroups({
      t: en,
      showScreenMemoryTab: isDesktopShellMode(),
      showUpdateTab: isDesktopShellMode(),
      hasOptionalUpdate: false,
      showExternalImportTab: false,
      access: null,
      installedCapabilities: new Set(),
    });
    const tabIds = groups.flatMap((g) => g.tabs.map((tab) => tab.id));
    expect(tabIds).toContain('appearance');
    expect(tabIds).toContain('agentEngine');

    // 「高级」组默认折叠：点组头展开，否则 agentEngine/hooks/appshots/cache 不在 DOM
    const advancedGroup = groups.find((g) => COLLAPSED_SETTINGS_TAB_GROUPS.has(g.id));
    expect(advancedGroup).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.settings.tabGroups[advancedGroup!.id] }));

    const nav = () => document.querySelector('nav') as HTMLElement;
    const navTexts = () => Array.from(nav().querySelectorAll('span, div'))
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent ?? '');

    const assertLanguage = (dict: Dict, other: Dict) => {
      const texts = navTexts();
      for (const group of groups) {
        const label = dict.settings.tabGroups[group.id];
        expect(texts, `组标题 ${group.id}`).toContain(label);
        const otherLabel = other.settings.tabGroups[group.id];
        if (otherLabel !== label) expect(texts, `组标题 ${group.id} 残留他语`).not.toContain(otherLabel);
      }
      for (const id of tabIds) {
        const label = expectedLabel(dict, id);
        expect(texts, `tab ${id}`).toContain(label);
        const otherLabel = expectedLabel(other, id);
        // 两种语言文案完全相同的 id 无法区分残留，跳过「不含他语」断言
        if (otherLabel !== label) expect(texts, `tab ${id} 残留他语`).not.toContain(otherLabel);
      }
    };

    assertLanguage(en, zh);

    act(() => useAppStore.setState({ language: 'zh' }));
    assertLanguage(zh, en);

    act(() => useAppStore.setState({ language: 'en' }));
    assertLanguage(en, zh);
  });
});
