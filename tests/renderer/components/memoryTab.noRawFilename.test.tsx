// @vitest-environment jsdom
// ============================================================================
// N-FIX-MEMORY-TAB-FILE-ROW-RAW-FILENAME —— 记忆文件列表不外露内部文件名
//   列表行只展示人读名称与描述，不得出现 memory-*.md（可见文本与 title 均不算）
//   data-memory-filename / 选中 / 删除 / 按文件名搜索等逻辑保持用内部文件名
// 走真实生产组件 MemoryTab，只 mock IPC 与语言（mock 模式取自 emptyValueNotShownAsNoneSurfaces）。
// ============================================================================
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const state = vi.hoisted(() => ({ lang: 'zh' as 'zh' | 'en' }));
const invoke = vi.hoisted(() => vi.fn());
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: state.lang === 'zh' ? zh : en, language: state.lang }) };
});
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke, invokeDomain },
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({ pickNativeFile: vi.fn() }));
vi.mock('../../../src/renderer/utils/platform', () => ({
  isTauriMode: () => false,
  isWebMode: () => true,
}));

import { MemoryTab } from '../../../src/renderer/components/features/settings/tabs/MemoryTab';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

beforeEach(() => {
  state.lang = 'zh';
  useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
  invoke.mockReset();
  invokeDomain.mockReset();
});

function installMemoryIpc(file: Record<string, unknown>) {
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'lightList') return Promise.resolve([file]);
    if (action === 'lightStats') return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
}

describe.each(['zh', 'en'] as const)('记忆列表不外露内部文件名（%s）', (lang) => {
  it('列表行与详情头部都只显示人读名称，无 memory-abc.md', async () => {
    state.lang = lang;
    const t = lang === 'zh' ? zh : en;
    const lightFile = {
      filename: 'memory-abc.md',
      name: lang === 'zh' ? '周报写作偏好' : 'Weekly Report Style',
      description: lang === 'zh' ? '记录周报的写作偏好' : 'How weekly reports should be written',
      type: 'user',
      content: lang === 'zh' ? '周报尽量简短。' : 'Keep weekly reports short.',
      updatedAt: '2026-11-01T08:00:00.000Z',
    };
    installMemoryIpc(lightFile);
    render(<MemoryTab />);

    const row = await screen.findByTestId('memory-file-row');
    // 身份与逻辑仍走内部文件名
    expect(row.getAttribute('data-memory-filename')).toBe('memory-abc.md');
    // 可见文本：人读名称在，内部文件名与扩展名不在
    const rowText = row.textContent ?? '';
    expect(rowText).toContain(lightFile.name);
    expect(rowText).toContain(lightFile.description);
    expect(rowText).not.toContain('.md');
    expect(rowText).not.toContain('memory-abc');
    // 行内任何元素的 title 都不得携带内部文件名
    const titles = Array.from(row.querySelectorAll('[title]')).map((el) => el.getAttribute('title'));
    expect(titles.every((title) => !title?.includes('.md'))).toBe(true);

    // 点击行 → 详情头部：人读名称 · 更新时间，同样无内部文件名
    fireEvent.click(row);
    const detailSection = await screen.findByText(t.settings.memory.files.detailTitle).then((el) => el.closest('section'));
    expect(detailSection).not.toBeNull();
    const headerText = detailSection?.querySelector('p')?.textContent ?? '';
    expect(headerText).toContain(lightFile.name);
    expect(headerText).not.toContain('.md');
    expect(headerText).not.toContain('memory-abc');
    // 整页可见文本兜底：内部文件名不出现在列表、详情、诊断等任何一处
    expect(document.body.textContent).not.toContain('memory-abc');
  });
});
