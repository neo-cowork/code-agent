// @vitest-environment jsdom
// 任务面板「工作文件夹」：可见文字与 title 都不露 /Users/<账户>，点击仍把真实路径交给访达。
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revealNativePath = vi.hoisted(() => vi.fn());
const lang = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));
const ROOT = '/Users/alice/work/foo';

vi.mock('../../../src/renderer/utils/platform', () => ({ isTauriMode: () => true, isWebMode: () => false }));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({ pickNativeDirectory: vi.fn(), revealNativePath }));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({ workingDirectory: ROOT, setWorkingDirectory: vi.fn() }),
}));
vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: (selector: (v: { workingDirectory: string }) => unknown) =>
    selector({ workingDirectory: '/Users/alice/work/next' }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: () => ({
    messages: [{
      id: 'm1', role: 'assistant', content: '', timestamp: 1,
      toolCalls: [
        { id: 't1', name: 'Read', arguments: { file_path: `${ROOT}/notes.txt` } },
        { id: 't2', name: 'Read', arguments: { file_path: '/Users/alice/Documents/a.txt' } },
      ],
    }],
  }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: lang.value === 'en' ? en : zh, language: lang.value }) };
});

import { WorkingFolder } from '../../../src/renderer/components/TaskPanel/WorkingFolder';

beforeEach(() => revealNativePath.mockReset().mockResolvedValue(undefined));
afterEach(cleanup);

describe.each(['zh', 'en'] as const)('WorkingFolder 不露绝对路径 (%s)', (language) => {
  it('可见文字与所有 title 不含 /Users/，显示短形式', () => {
    lang.value = language;
    const { container } = render(<WorkingFolder />);
    expect(container.innerHTML).not.toContain('/Users/');
    const titles = Array.from(container.querySelectorAll('[title]')).map((el) => el.getAttribute('title'));
    expect(titles).toEqual(expect.arrayContaining(['~/work/foo', './notes.txt', '~/Documents/a.txt']));
    expect(container.textContent).toContain('~/work/foo');
    expect(container.textContent).toContain('~/work/next');
  });

  it('点击仍把真实绝对路径交给 reveal', async () => {
    lang.value = language;
    const { getByTitle } = render(<WorkingFolder />);
    fireEvent.click(getByTitle('~/work/foo'));
    fireEvent.click(getByTitle('~/Documents/a.txt'));
    await waitFor(() => {
      expect(revealNativePath).toHaveBeenCalledWith(ROOT);
      expect(revealNativePath).toHaveBeenCalledWith('/Users/alice/Documents/a.txt');
    });
  });
});
