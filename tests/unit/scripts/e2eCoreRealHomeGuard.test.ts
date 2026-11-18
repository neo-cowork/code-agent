import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { approveCard, RealHomeWriteError } from '../../../scripts/e2e-core/ui';

// 最小的页面替身：只有一张审批卡，记录点了哪个按钮
function fakePage(cardText: string) {
  const clicked: string[] = [];
  let visible = true;
  const card = {
    first: () => card,
    innerText: async () => cardText,
    isVisible: async () => visible,
    count: async () => (visible ? 1 : 0),
    getByRole: (_role: string, opts: { name: string }) => ({
      count: async () => 1,
      click: async () => { clicked.push(opts.name); visible = false; },
    }),
  };
  const page = { getByTestId: () => card } as unknown as Page;
  return { page, clicked };
}

const realPath = path.join(os.homedir(), '.code-agent', 'memory', '周报格式偏好.md');

describe('e2e-core real-home guard on every approve click', () => {
  it('denies, never approves, a card that writes the real data dir (any flow / session)', async () => {
    const { page, clicked } = fakePage(`允许写入 ${realPath}（工作区外）？`);
    await expect(approveCard(page)).rejects.toBeInstanceOf(RealHomeWriteError);
    expect(clicked).toEqual(['拒绝']);
  });

  it('still approves a card whose path is inside the isolated home', async () => {
    const { page, clicked } = fakePage('允许写入 /Users/someone/work/out/x/neo/home/.code-agent/memory/a.md？');
    await approveCard(page);
    expect(clicked).toEqual(['允许一次']);
  });
});
