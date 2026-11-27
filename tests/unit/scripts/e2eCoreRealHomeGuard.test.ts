import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { approveCard, RealHomeWriteError } from '../../../scripts/e2e-core/ui';

// 最小的页面替身：一张改版后的审批卡。卡面只有一句话和两个按钮，完整路径在「更多选项与详情」里，
// 不展开读不到——护栏如果不先展开就读卡，这里会把真实主目录的写入点成「允许」。
function fakePage(detailText: string, replaceAfterRead = false) {
  const clicked: string[] = [];
  let visible = true;
  let expanded = false;
  let requestId = 'first';
  const buttons = (): string[] => (expanded ? ['允许', '暂不'] : ['更多选项与详情', '允许', '暂不']);
  const locator = (id?: string) => {
    const matches = () => visible && (!id || requestId === id);
    const card = {
      first: () => card,
      innerText: async () => {
        const text = expanded ? `允许写入这个文件？ ${detailText}` : '允许写入这个文件？';
        if (replaceAfterRead) requestId = 'second';
        return text;
      },
      isVisible: async () => matches(),
      getByRole: (_role: string, opts: { name: string }) => ({
        count: async () => (matches() && buttons().includes(opts.name) ? 1 : 0),
        click: async () => {
          if (!matches()) throw new Error('Permission request left the slot');
          clicked.push(`${requestId}: ${opts.name}`);
          if (opts.name === '更多选项与详情') expanded = true;
          else visible = false;
        },
      }),
    };
    return card;
  };
  const page = {
    getByTestId: () => locator(),
    locator: (selector: string) => ({
      filter: () => ({ evaluateAll: async () => [requestId] }),
      getByTestId: () => locator(JSON.parse(selector.slice('[data-permission-request-id='.length, -1))),
    }),
  } as unknown as Page;
  return { page, clicked };
}

const realPath = path.join(os.homedir(), '.code-agent', 'memory', '周报格式偏好.md');

describe('e2e-core real-home guard on every approve click', () => {
  it('denies, never approves, a card that writes the real data dir (any flow / session)', async () => {
    const { page, clicked } = fakePage(`将在工作区外写入 ${realPath}`);
    await expect(approveCard(page)).rejects.toBeInstanceOf(RealHomeWriteError);
    expect(clicked).toEqual(['first: 更多选项与详情', 'first: 暂不']);
  });

  it('still approves a card whose path is inside the isolated home', async () => {
    const { page, clicked } = fakePage('将在工作区外写入 /Users/someone/work/out/x/neo/home/.code-agent/memory/a.md');
    await approveCard(page);
    expect(clicked).toEqual(['first: 更多选项与详情', 'first: 允许']);
  });

  it('never clicks the replacement request after inspecting the original command', async () => {
    const { page, clicked } = fakePage('isolated workspace', true);
    await expect(approveCard(page)).rejects.toThrow('Permission request left the slot');
    expect(clicked).toEqual(['first: 更多选项与详情']);
  });
});
