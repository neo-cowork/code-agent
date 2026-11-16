// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { HooksSettings } from '../../../src/renderer/components/features/settings/tabs/HooksSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const invoke = vi.fn();
const forbidden = { success: false, error: { code: 'FORBIDDEN', message: 'Hooks: Admin permission required' } };
const okList = {
  success: true,
  data: {
    enabled: [{ event: 'PreToolUse', description: 'before tool', matcher: 'Bash', type: 'command', hint: 'echo hi', sources: ['global'], hookType: 'decision', parallel: false, disabled: false, key: 'k1' }],
    unused: [{ event: 'Stop', description: 'stop' }],
    configPaths: { global: '/home/u/.code-agent/hooks/hooks.json', project: null },
  },
};

function setup(language: 'zh' | 'en') {
  useAppStore.setState({ language });
  (window as unknown as { domainAPI: unknown }).domainAPI = { invoke };
}

afterEach(() => { cleanup(); invoke.mockReset(); useAppStore.setState({ language: 'zh' }); });

describe.each([['zh', zh], ['en', en]] as const)('HooksSettings load failure (%s)', (language, locale) => {
  const h = locale.settings.hooks;

  it.each([
    ['FORBIDDEN', forbidden],
    ['HTTP_403', { success: false, error: { code: 'HTTP_403', message: 'Forbidden' } }],
  ])('%s: 显示无权限说明，不显示计数/路径/原始错误', async (_n, resp) => {
    setup(language);
    invoke.mockResolvedValue(resp);
    const { container } = render(<HooksSettings />);
    await screen.findByText(h.forbidden);
    expect(screen.queryByText(new RegExp(`${h.enabledTitle}\\s*\\(`))).toBeNull();
    expect(container.textContent).not.toMatch(/\(\d+\)/);
    expect(container.textContent).not.toContain('hooks.json"');
    expect(screen.queryByText(h.configActions.open)).toBeNull();
    expect(container.textContent).not.toContain('Admin permission required');
    expect(container.textContent).not.toContain('加载失败：Hooks:');
  });

  it('其他失败：通用提示，不显示原始文本', async () => {
    setup(language);
    invoke.mockResolvedValue({ success: false, error: { code: 'INTERNAL', message: 'ECONNRESET boom' } });
    const { container } = render(<HooksSettings />);
    await screen.findByText(h.loadFailed);
    expect(container.textContent).not.toContain('ECONNRESET');
    expect(container.textContent).not.toMatch(/\(\d+\)/);
  });

  it('刷新：仍被拒 -> 同一句；随后成功 -> 真实列表与计数', async () => {
    setup(language);
    invoke.mockResolvedValueOnce(forbidden).mockResolvedValueOnce(forbidden).mockResolvedValueOnce(okList);
    const { container } = render(<HooksSettings />);
    await screen.findByText(h.forbidden);
    fireEvent.click(screen.getByRole('button', { name: h.refresh }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await screen.findByText(h.forbidden);
    fireEvent.click(screen.getByRole('button', { name: h.refresh }));
    await screen.findByText('PreToolUse');
    expect(screen.queryByText(h.forbidden)).toBeNull();
    expect(container.textContent).toContain(`${h.enabledTitle} (1)`);
    expect(container.textContent).toContain('/home/u/.code-agent/hooks/hooks.json');
  });
});
