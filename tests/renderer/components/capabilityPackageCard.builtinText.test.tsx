// @vitest-environment jsdom
// N-FIX-CAPABILITYHUB-BUILTIN-CARDS-ZH-ENGLISH-MIX：
// 内置插件卡片名/描述走 capabilityPackages.builtinPlugins 词条，不走 host manifest 原文。
// 完备性：host 的 BUILTIN_CAPABILITY_IDS 每个 id 在 zh/en 都得有词条（测试直接 import host 文件）。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_CAPABILITY_IDS, type BuiltinCapabilityId } from '../../../src/host/plugins/builtin/builtinCapabilityIds';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import type { InstalledCapabilityPackage } from '../../../src/shared/contract/capabilityPackage';

const language = vi.hoisted(() => ({ current: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: language.current === 'zh' ? zh : en, language: language.current }),
}));

import { CapabilityPackageCard } from '../../../src/renderer/components/features/settings/tabs/CapabilityPackageCard';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// 形状对齐 host manifest（audioProcessing）：英文工程名 + 带术语的中文工程描述
function builtinPlugin(id: BuiltinCapabilityId): InstalledCapabilityPackage {
  return {
    id,
    name: 'Audio Processing',
    version: '1.0.0',
    description: '文字转语音（GLM-TTS）。ASR 走 local_speech_to_text 本地路径。',
    permissions: ['network'],
    state: 'available',
    surface: 'tools',
    toolNames: ['text_to_speech'],
  };
}

const callbacks = {
  onInstall: vi.fn(),
  onUninstall: vi.fn(),
  onReinstall: vi.fn(),
  onRunVersion: vi.fn(),
};

beforeEach(() => {
  Object.values(callbacks).forEach((callback) => callback.mockReset());
  useAppStore.setState({ activeInternalFeatureId: null, showCapabilityHub: true });
});

afterEach(cleanup);

describe('builtin plugin card copy completeness', () => {
  it('BUILTIN_CAPABILITY_IDS 每个 id 在 zh 和 en 都有名称与描述词条', () => {
    for (const id of BUILTIN_CAPABILITY_IDS) {
      expect(Object.hasOwn(zh.capabilityPackages.builtinPlugins, id)).toBe(true);
      expect(Object.hasOwn(en.capabilityPackages.builtinPlugins, id)).toBe(true);
      const zhEntry = zh.capabilityPackages.builtinPlugins[id];
      const enEntry = en.capabilityPackages.builtinPlugins[id];
      expect(zhEntry.name.trim().length).toBeGreaterThan(0);
      expect(zhEntry.description.trim().length).toBeGreaterThan(0);
      expect(enEntry.name.trim().length).toBeGreaterThan(0);
      expect(enEntry.description.trim().length).toBeGreaterThan(0);
      // zh 名称必须是中文词条，不许把 host manifest 的英文名原样当 zh 名
      expect(zhEntry.name).toMatch(/[一-鿿]/);
      expect(zhEntry.description).toMatch(/[一-鿿]/);
    }
  });
});

describe('CapabilityPackageCard builtin card copy', () => {
  it('zh 卡片显示中文名称与说明，不显示 host manifest 的英文名和工程描述', () => {
    language.current = 'zh';
    render(<CapabilityPackageCard plugin={builtinPlugin('builtin.audioProcessing')} busyKey={null} packageBusy={false} {...callbacks} />);

    expect(screen.getByText(zh.capabilityPackages.builtinPlugins['builtin.audioProcessing'].name)).toBeTruthy();
    expect(screen.getByText(zh.capabilityPackages.builtinPlugins['builtin.audioProcessing'].description)).toBeTruthy();
    expect(screen.queryByText('Audio Processing')).toBeNull();
    expect(screen.queryByText('文字转语音（GLM-TTS）。ASR 走 local_speech_to_text 本地路径。')).toBeNull();
  });

  it('en 卡片保留英文词条名称与英文说明，不显示 host manifest 的中文工程描述', () => {
    language.current = 'en';
    render(<CapabilityPackageCard plugin={builtinPlugin('builtin.audioProcessing')} busyKey={null} packageBusy={false} {...callbacks} />);

    expect(screen.getByText(en.capabilityPackages.builtinPlugins['builtin.audioProcessing'].name)).toBeTruthy();
    expect(screen.getByText(en.capabilityPackages.builtinPlugins['builtin.audioProcessing'].description)).toBeTruthy();
    expect(screen.queryByText('文字转语音（GLM-TTS）。ASR 走 local_speech_to_text 本地路径。')).toBeNull();
  });

  it('第三方插件 id 没有词条，回退 manifest 原文', () => {
    language.current = 'zh';
    const thirdParty: InstalledCapabilityPackage = { ...builtinPlugin('builtin.audioProcessing'), id: 'weekly-report-helper', name: '周报助手' };
    render(<CapabilityPackageCard plugin={thirdParty} busyKey={null} packageBusy={false} {...callbacks} />);

    expect(screen.getByText('周报助手')).toBeTruthy();
    expect(screen.queryByText(zh.capabilityPackages.builtinPlugins['builtin.audioProcessing'].name)).toBeNull();
  });
});
