// @vitest-environment jsdom
// 记忆文件「归档」确认框：网页版与桌面版都必须能点确认并完成，不许出现无说明的灰按钮。
// 走真实生产组件 MemoryTab，只 mock IPC、语言与平台判断。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { IPC_DOMAINS } from '../../../src/shared/ipc/domains';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const state = vi.hoisted(() => ({ lang: 'zh' as 'zh' | 'en', web: true, archiveOk: true }));
const invoke = vi.hoisted(() => vi.fn());
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: state.lang === 'zh' ? zh : en, language: state.lang }) };
});
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => !state.web, invoke, invokeDomain },
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({ pickNativeFile: vi.fn() }));
vi.mock('../../../src/renderer/utils/platform', () => ({
  isTauriMode: () => false,
  isWebMode: () => state.web,
}));

import { MemoryTab } from '../../../src/renderer/components/features/settings/tabs/MemoryTab';

const FILENAME = 'weekly-style.md';
const file = {
  filename: FILENAME, name: '周报偏好', description: 'weekly', type: 'user',
  content: 'content', updatedAt: '2026-11-10T08:00:00.000Z',
};

function installIpc() {
  const handle = (action: string) => {
    if (action === 'lightList') return [file];
    if (action === 'lightDelete') return state.archiveOk;
    return undefined;
  };
  invokeDomain.mockImplementation((_d: string, action: string) => Promise.resolve(handle(action)));
  invoke.mockImplementation((channel: string, req?: { action?: string }) => {
    if (channel === IPC_CHANNELS.MEMORY) {
      const data = handle(req?.action ?? '');
      return Promise.resolve({ success: data !== false, data });
    }
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  state.lang = 'zh';
  state.web = true;
  state.archiveOk = true;
  installIpc();
});
afterEach(() => {
  cleanup();
  invoke.mockReset();
  invokeDomain.mockReset();
});

describe.each([
  { lang: 'zh' as const, web: true },
  { lang: 'en' as const, web: true },
  { lang: 'zh' as const, web: false },
  { lang: 'en' as const, web: false },
])('归档确认框（$lang，网页版=$web）', ({ lang, web }) => {
  const t = lang === 'zh' ? zh : en;
  const files = t.settings.memory.files;

  async function openConfirm() {
    state.lang = lang;
    state.web = web;
    render(<MemoryTab />);
    await screen.findByText(FILENAME);
    const rowButton = screen.getAllByRole('button', { name: files.delete })[0];
    expect(rowButton.textContent).toBe(files.delete);
    fireEvent.click(rowButton);
    const title = await screen.findByText(files.archiveConfirmTitle);
    expect(title.textContent).toBe(lang === 'zh' ? '归档这个记忆文件？' : 'Archive this memory file?');
    const dialog = screen.getByRole('dialog');
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === files.delete) as HTMLButtonElement;
    expect(confirm.textContent).toBe(lang === 'zh' ? '归档' : 'Archive');
    return confirm;
  }

  function calls() {
    return (web ? invokeDomain : invoke).mock.calls.filter((c) => (web ? c[1] : c[1]?.action) === 'lightDelete');
  }

  it('确认按钮可点，点后走对应通道并提示已归档', async () => {
    const confirm = await openConfirm();
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await screen.findByText(`${files.deleteSuccessPrefix}${FILENAME}`);
    const call = calls()[0];
    if (web) {
      expect(call).toEqual([IPC_DOMAINS.MEMORY, 'lightDelete', { action: 'lightDelete', filename: FILENAME }]);
    } else {
      expect(call).toEqual([IPC_CHANNELS.MEMORY, { action: 'lightDelete', filename: FILENAME }]);
    }
  });

  it('归档失败时提示归档失败', async () => {
    state.archiveOk = false;
    const confirm = await openConfirm();
    fireEvent.click(confirm);
    await waitFor(() => expect(calls().length).toBeGreaterThan(0));
    await screen.findByText(files.deleteFailed);
    expect(files.deleteFailed).toBe(lang === 'zh' ? '归档失败' : 'Archive failed');
  });
});
