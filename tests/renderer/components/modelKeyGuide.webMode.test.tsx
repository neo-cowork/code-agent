// @vitest-environment jsdom
// 网页版存不了密钥：「还没有密钥？先在这里填」引导条不能出现；桌面版保持原样。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { AppSettings } from '../../../src/shared/contract';

const webMode = vi.hoisted(() => ({ value: true }));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/utils/platform')>()),
  isWebMode: () => webMode.value,
}));

import { ModelKeyGuide } from '../../../src/renderer/components/features/settings/tabs/ModelKeyGuide';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const settings = { models: { default: 'openai', providers: { openai: { enabled: true } } } } as unknown as AppSettings;

beforeEach(() => { webMode.value = true; });
afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });

describe.each([['zh', zh], ['en', en]] as const)('ModelKeyGuide web mode (%s)', (language, locale) => {
  const label = locale.settings.model.header.noKeyGuide;
  const view = () => {
    useAppStore.setState({ language });
    return render(<ModelKeyGuide settings={settings} defaultProvider="openai" />);
  };

  it('web: 不出现引导按钮', () => {
    const { container } = view();
    expect(container.textContent).not.toContain(label);
    expect(container.querySelector('[data-model-key-guide]')).toBeNull();
  });

  it('desktop: 引导按钮仍在', () => {
    webMode.value = false;
    const { container } = view();
    expect(container.textContent).toContain(label);
  });
});
