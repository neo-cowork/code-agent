import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { approveCard, expandCard, RealHomeWriteError } from '../../../scripts/e2e-core/ui';

// 最小的页面替身：一张改版后的审批卡。卡面只有一句话和两个按钮，完整路径在「更多选项与详情」里，
// 不展开读不到——护栏如果不先展开就读卡，这里会把真实主目录的写入点成「允许」。
function fakePage(detailText: string) {
  const clicked: string[] = [];
  let visible = true;
  let expanded = false;
  const buttons = (): string[] => (expanded ? ['允许', '暂不'] : ['更多选项与详情', '允许', '暂不']);
  const card = {
    first: () => card,
    innerText: async () => (expanded ? `允许写入这个文件？ ${detailText}` : '允许写入这个文件？'),
    isVisible: async () => visible,
    count: async () => (visible ? 1 : 0),
    getByRole: (_role: string, opts: { name: string }) => ({
      count: async () => (buttons().includes(opts.name) ? 1 : 0),
      click: async () => {
        clicked.push(opts.name);
        if (opts.name === '更多选项与详情') expanded = true;
        else visible = false;
      },
    }),
  };
  const page = { getByTestId: () => card } as unknown as Page;
  return { page, clicked };
}

const realPath = path.join(os.homedir(), '.code-agent', 'memory', '周报格式偏好.md');

describe('e2e-core real-home guard on every approve click', () => {
  it('denies, never approves, a card that writes the real data dir (any flow / session)', async () => {
    const { page, clicked } = fakePage(`将在工作区外写入 ${realPath}`);
    await expect(approveCard(page)).rejects.toBeInstanceOf(RealHomeWriteError);
    expect(clicked).toEqual(['更多选项与详情', '暂不']);
  });

  it('still approves a card whose path is inside the isolated home', async () => {
    const { page, clicked } = fakePage('将在工作区外写入 /Users/someone/work/out/x/neo/home/.code-agent/memory/a.md');
    await approveCard(page);
    expect(clicked).toEqual(['更多选项与详情', '允许']);
  });

  it('returns false from expandCard when the card detaches mid-click instead of timing out', async () => {
    let detached = false;
    const card = {
      first: () => card,
      count: async () => (detached ? 0 : 1),
      getByRole: (_role: string, opts: { name: string }) => ({
        count: async () => (!detached && opts.name === '更多选项与详情' ? 1 : 0),
        click: async () => {
          detached = true;
          throw new Error('locator.click: Timeout 3000ms exceeded. element was detached from the DOM');
        },
      }),
    };
    const page = { getByTestId: () => card } as unknown as Page;
    await expect(expandCard(page)).resolves.toBe(false);
  });

  it('rethrows from expandCard when the expand button is still present and unclickable', async () => {
    const card = {
      first: () => card,
      count: async () => 1,
      getByRole: (_role: string, opts: { name: string }) => ({
        count: async () => (opts.name === '更多选项与详情' ? 1 : 0),
        click: async () => {
          throw new Error('locator.click: Timeout 3000ms exceeded. element is not stable');
        },
      }),
    };
    const page = { getByTestId: () => card } as unknown as Page;
    await expect(expandCard(page)).rejects.toThrow('element is not stable');
  });
});
