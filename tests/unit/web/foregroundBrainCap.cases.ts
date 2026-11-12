import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';

/** Run the cap matrix inside agentRouter.test.ts's real HTTP router fixture. */
export function foregroundBrainCapCases(run: (input: {
  prompt: string; history?: Message[]; requestedCap?: number; goal?: boolean;
}) => Promise<{ cap: number | undefined; logs: string[] }>): void {
  describe('foreground brain cap through /api/run', () => {
    it.each([
      ['先出 3 种风格样张,选定后合成 8 页 PPTX', 30],
      ['制作 PPT', 30], ['制作幻灯片演示稿', 30],
      ['做 Excel 表格', 30], ['导出 XLSX', 30],
      ['写 Word 文档报告', 30], ['生成 DOCX', 30],
      ['导出 PDF', 30], ['制作 HTML 网页', 30],
      ['今天天气', 8], ['今天适合穿什么?', 8], ['帮我查一下', 8],
      ['continue', 8], ['excellent wordpress support', 8],
    ])('resolves %s to %i', async (prompt, cap) => {
      const result = await run({ prompt });
      expect(result.cap).toBe(cap);
      expect(result.logs).toEqual([
        `Foreground brain budget rule=${cap === 30 ? 'deliverable' : 'default'} cap=${cap} maxIterations=${cap}`,
      ]);
    });

    it.each([false, true])('uses only the last persisted assistant marker: %s', async marked => {
      const history: Message[] = [
        { id: 'old-stop', role: 'assistant', content: 'earlier stop', timestamp: 1,
          metadata: { stoppedByStepLimit: true } },
        { id: 'last-answer', role: 'assistant', content: 'progress', timestamp: 2,
          ...(marked ? { metadata: { stoppedByStepLimit: true } } : {}) },
        { id: 'meta', role: 'assistant', content: 'wake', timestamp: 2, isMeta: true,
          ...(marked ? {} : { metadata: { stoppedByStepLimit: true as const } }) },
        { id: 'rewound', role: 'assistant', content: 'rewound', timestamp: 2, visibility: 'rewound',
          ...(marked ? {} : { metadata: { stoppedByStepLimit: true as const } }) },
        { id: 'last-user', role: 'user', content: 'a follow-up', timestamp: 3 },
      ];
      const result = await run({ prompt: '继续', history });
      const cap = marked ? 30 : 8;
      expect(result.cap).toBe(cap);
      expect(result.logs).toEqual([
        `Foreground brain budget rule=${marked ? 'continuation' : 'default'} cap=${cap} maxIterations=${cap}`,
      ]);
    });

    it('preserves an explicit smaller cap for deliverable and continuation turns', async () => {
      expect((await run({ prompt: '制作 PPTX', requestedCap: 4 })).cap).toBe(4);
      const result = await run({ prompt: '继续', requestedCap: 4, history: [
        { id: 'stop', role: 'assistant', content: 'progress', timestamp: 1,
          metadata: { stoppedByStepLimit: true } },
      ] });
      expect(result.cap).toBe(4);
      expect(result.logs).toContain('Foreground brain budget rule=continuation cap=30 maxIterations=4');
    });

    it.each([
      { prompt: '/test PPTX' }, { prompt: '制作 PPTX', goal: true },
    ])('leaves slash/goal budgets unchanged: %j', async input => {
      const result = await run({ ...input, requestedCap: 50 });
      expect(result.cap).toBe(50);
      expect(result.logs).toEqual([]);
    });
  });
}
