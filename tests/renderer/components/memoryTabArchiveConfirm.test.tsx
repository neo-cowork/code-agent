// @vitest-environment jsdom
// 记忆文件「归档」确认框：网页版与桌面版都必须能点确认并完成，不许出现无说明的灰按钮。
// 走真实生产组件 MemoryTab，只 mock IPC、语言与平台判断。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { IPC_DOMAINS } from '../../../src/shared/ipc/domains';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

interface MockLightFile {
  filename: string;
  name: string;
  description: string;
  type: string;
  content: string;
  updatedAt: string;
  status?: 'active' | 'archived';
}

const state = vi.hoisted(() => ({
  lang: 'zh' as 'zh' | 'en',
  web: true,
  archiveOk: true,
  files: [] as MockLightFile[],
}));
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
  const handle = (action: string, payload?: { filename?: string }) => {
    if (action === 'lightList') return state.files.map((item) => ({ ...item }));
    if (action === 'lightStats') {
      return {
        totalFiles: state.files.length,
        byType: {},
        sessionStats: null,
        recentConversations: [],
      };
    }
    if (action === 'lightDelete') {
      if (!state.archiveOk) return false;
      const target = state.files.find((item) => item.filename === payload?.filename);
      if (target) target.status = 'archived';
      return true;
    }
    return undefined;
  };
  invokeDomain.mockImplementation((_d: string, action: string, payload?: { filename?: string }) => (
    Promise.resolve(handle(action, payload))
  ));
  invoke.mockImplementation((channel: string, req?: { action?: string; filename?: string }) => {
    if (channel === IPC_CHANNELS.MEMORY) {
      const data = handle(req?.action ?? '', req);
      return Promise.resolve({ success: data !== false, data });
    }
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  state.lang = 'zh';
  state.web = true;
  state.archiveOk = true;
  state.files = [{ ...file }];
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
    // 列表行只显示人读名称（N-FIX-MEMORY-TAB-FILE-ROW-RAW-FILENAME）；内部文件名仍经 data-memory-filename 与 IPC 断言覆盖
    await screen.findByText(file.name);
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
    // 归档成功提示显示人读名称；lightDelete 请求本身仍带内部文件名（下方 IPC 断言）
    await screen.findByText(`${files.deleteSuccessPrefix}${file.name}`);
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

describe('记忆文件管理列表归档过滤与就近反馈', () => {
  const filesText = zh.settings.memory.files;

  function getManagementSection(): HTMLElement {
    const heading = screen.getByText(filesText.managementTitle);
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    return section as HTMLElement;
  }

  it('(a) lightList 含已归档文件时，列表只渲染未归档行、页面不含已归档名称、记忆文件数卡片显示 1', async () => {
    state.files = [
      { ...file, status: 'active' },
      {
        filename: 'archived-note.md',
        name: '已归档周报规则',
        description: 'archived desc',
        type: 'user',
        content: 'archived body',
        updatedAt: '2026-11-09T08:00:00.000Z',
        status: 'archived',
      },
    ];
    render(<MemoryTab />);

    await screen.findByText(file.name);
    expect(screen.getAllByTestId('memory-file-row')).toHaveLength(1);
    expect(screen.queryByText('已归档周报规则')).toBeNull();

    const section = getManagementSection();
    const tileLabel = within(section).getByText(filesText.stats.memoryFiles);
    const tileCard = tileLabel.parentElement;
    expect(tileCard?.children[1]?.textContent).toBe('1');
  });

  it('(b) 行内归档成功后重载返回 status=archived，该行立即消失并在管理区显示带名称的成功提示', async () => {
    state.files = [{ ...file, status: 'active' }];
    render(<MemoryTab />);

    const row = await screen.findByTestId('memory-file-row');
    fireEvent.click(within(row).getByRole('button', { name: filesText.delete }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: filesText.delete }));

    await waitFor(() => {
      expect(screen.queryByTestId('memory-file-row')).toBeNull();
    });
    expect(screen.queryByText(file.name, { selector: 'td span' })).toBeNull();

    const section = getManagementSection();
    const msg = within(section).getByTestId('memory-file-archive-message');
    expect(msg.getAttribute('role')).toBe('status');
    expect(msg.textContent).toBe(`${filesText.deleteSuccessPrefix}${file.name}`);
  });

  it('(c) lightDelete 返回 false 时，行保留并在管理区显示归档失败提示', async () => {
    state.archiveOk = false;
    state.files = [{ ...file, status: 'active' }];
    render(<MemoryTab />);

    const row = await screen.findByTestId('memory-file-row');
    fireEvent.click(within(row).getByRole('button', { name: filesText.delete }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: filesText.delete }));

    const section = getManagementSection();
    const msg = await within(section).findByTestId('memory-file-archive-message');
    expect(msg.getAttribute('role')).toBe('status');
    expect(msg.textContent).toBe(filesText.deleteFailed);
    expect(screen.getAllByTestId('memory-file-row')).toHaveLength(1);
  });
});
