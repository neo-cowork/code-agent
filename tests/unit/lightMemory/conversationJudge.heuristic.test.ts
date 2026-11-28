// ============================================================================
// Light Memory — conversationJudge heuristic fallback & LLM highlight backfill
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const mockMemoryTask = vi.hoisted(() =>
  vi.fn(async () => ({ success: false as boolean, content: undefined as string | undefined, error: 'unavailable' as string | undefined })),
);
const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../src/host/config/configPaths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => mockConfigDir.dir };
});
vi.mock('../../../src/host/model/quickModel', () => ({
  memoryTask: mockMemoryTask,
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => loggerSpies,
}));

import { judgeConversation } from '../../../src/host/lightMemory/conversationJudge';
import { appendConversationSummary } from '../../../src/host/lightMemory/recentConversations';

const MULTI_LINE_TURN =
  '\n  看一下 q3.txt   里的 Q3 销售数据，告诉我哪个区域增长最快  \n顺便核对一下华东和华南两个大区的退货率差异\n把口径说明放在备注里';

// > 70 chars: exercises 50-char title truncation vs 60-char highlight truncation prefix match.
const SEVENTY_PLUS_CHAR_TURN =
  '请把华东、华南、华北、西南四个大区在第三季度的净销售额、环比增速以及异常退货原因汇总成一份可直接发给管理层的复盘简报草稿并附上三条可执行改进建议';

describe('conversationJudge heuristic fallback and highlight backfill', () => {
  let tmpDir: string;
  let summaryPath: string;

  beforeEach(async () => {
    mockMemoryTask.mockReset();
    mockMemoryTask.mockResolvedValue({ success: false, content: undefined, error: 'unavailable' });
    loggerSpies.info.mockReset();
    loggerSpies.warn.mockReset();
    loggerSpies.error.mockReset();
    loggerSpies.debug.mockReset();

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lm-heuristic-'));
    mockConfigDir.dir = tmpDir;
    summaryPath = path.join(tmpDir, 'memory', 'recent-conversations.md');
    await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('(a) does not repeat the latest message in highlights or recent-conversations row (including 70+ char truncation and multi-line input)', async () => {
    expect(SEVENTY_PLUS_CHAR_TURN.length).toBeGreaterThanOrEqual(70);

    const judgment = await judgeConversation({
      userMessages: [
        MULTI_LINE_TURN,
        '再对比一下 Q2 到 Q3 各区域客单价的变化幅度',
        SEVENTY_PLUS_CHAR_TURN,
      ],
    });

    expect(judgment.source).toBe('heuristic');
    expect(judgment.worth).toBe(true);
    expect(judgment.title).toContain('...');
    expect(judgment.title).not.toContain('\n');

    const titleCore = judgment.title.replace(/\.\.\.$/, '');
    for (const highlight of judgment.worthKnowledge) {
      const highlightCore = highlight.replace(/\.\.\.$/, '');
      expect(highlightCore).not.toBe(titleCore);
      expect(titleCore.startsWith(highlightCore)).toBe(false);
      expect(highlightCore.startsWith(titleCore)).toBe(false);
    }

    expect(judgment.worthKnowledge).toEqual([
      '再对比一下 Q2 到 Q3 各区域客单价的变化幅度',
      '看一下 q3.txt 里的 Q3 销售数据，告诉我哪个区域增长最快',
    ]);

    await appendConversationSummary(
      {
        date: '2026-11-27',
        title: judgment.title,
        highlights: judgment.worthKnowledge,
      },
      { enabled: true },
    );

    const raw = await fs.readFile(summaryPath, 'utf8');
    const row = raw.split('\n').find((line) => line.startsWith('- **2026-11-27**'));
    expect(row).toBeDefined();
    const match = row!.match(/^- \*\*2026-11-27\*\*: "(.+?)" — (.*)$/);
    expect(match).not.toBeNull();
    const [, persistedTitle, persistedHighlights] = match!;
    expect(persistedHighlights).not.toContain(persistedTitle);
    expect(persistedHighlights).not.toContain(titleCore);

    // Single substantive message yields an empty highlight list rather than echoing the title.
    const single = await judgeConversation({
      userMessages: ['继续，把 Q3 的数字总结成三条要点'],
    });
    expect(single.worth).toBe(true);
    expect(single.title).toBe('继续，把 Q3 的数字总结成三条要点');
    expect(single.worthKnowledge).toEqual([]);
  });

  it('(b) uses the most recent substantive message as title and drops filler from highlights when trailing turns are filler (继续 / 好的 / 嗯 / go on)', async () => {
    for (const trailingFiller of ['继续', '好的！', '嗯嗯', 'go on...']) {
      const judgment = await judgeConversation({
        userMessages: [
          '看一下 q3.txt 里的 Q3 销售数据，告诉我哪个区域增长最快',
          '嗯',
          '把增长最快和最慢的两个区域写成三点摘要放到 summary.md',
          trailingFiller,
        ],
      });

      expect(judgment.source).toBe('heuristic');
      expect(judgment.worth).toBe(true);
      expect(judgment.title).toBe('把增长最快和最慢的两个区域写成三点摘要放到 summary.md');
      expect(judgment.worthKnowledge).toEqual([
        '看一下 q3.txt 里的 Q3 销售数据，告诉我哪个区域增长最快',
      ]);
      expect(JSON.stringify(judgment.worthKnowledge)).not.toMatch(/继续|好的|嗯|go on/i);
    }
  });

  it('(c) returns worth=false, writes no summary row, and logs heuristic_no_substantive_message when all turns are filler', async () => {
    const judgment = await judgeConversation({
      userMessages: ['继续', '嗯', 'ok!'],
    });

    expect(judgment.source).toBe('heuristic');
    expect(judgment.worth).toBe(false);
    expect(judgment.title).toBe('');
    expect(judgment.worthKnowledge).toEqual([]);

    if (judgment.worth && judgment.title) {
      await appendConversationSummary(
        { date: '2026-11-27', title: judgment.title, highlights: judgment.worthKnowledge },
        { enabled: true },
      );
    }

    await expect(fs.readFile(summaryPath, 'utf8')).rejects.toThrow();
    expect(loggerSpies.info).toHaveBeenCalledTimes(1);
    expect(loggerSpies.info).toHaveBeenCalledWith(
      'Heuristic summary skipped: no substantive user message',
      {
        reason: 'heuristic_no_substantive_message',
        userMessageCount: 3,
      },
    );
    expect(JSON.stringify(loggerSpies.info.mock.calls)).not.toMatch(/继续|嗯|ok!/);
  });

  it('(d) backfills the latest substantive message without filler when LLM returns worth=true with empty worthKnowledge and a paraphrased title', async () => {
    mockMemoryTask.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({
        worth: true,
        isMeeting: false,
        title: 'Q3 各大区销售增速对比与复盘纪要',
        worthKnowledge: [],
        durableFacts: [],
      }),
      error: undefined,
    });

    const judgment = await judgeConversation({
      userMessages: [
        '看一下 q3.txt 里的 Q3 销售数据，告诉我哪个区域增长最快',
        '再把三个最关键的变化写进 summary.md',
        '继续',
      ],
    });

    expect(judgment.source).toBe('llm');
    expect(judgment.worth).toBe(true);
    expect(judgment.title).toBe('Q3 各大区销售增速对比与复盘纪要');
    expect(judgment.worthKnowledge).toEqual([
      '再把三个最关键的变化写进 summary.md',
      '看一下 q3.txt 里的 Q3 销售数据，告诉我哪个区域增长最快',
    ]);
    expect(judgment.worthKnowledge).not.toContain('继续');

    // LLM-provided worthKnowledge stays untouched when non-empty.
    mockMemoryTask.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({
        worth: true,
        isMeeting: false,
        title: 'Q3 区域复盘',
        worthKnowledge: ['对比四大区 Q3 环比增速并提炼三条核心变化'],
        durableFacts: [],
      }),
      error: undefined,
    });

    const withExplicitHighlights = await judgeConversation({
      userMessages: ['看一下 q3.txt 里的 Q3 销售数据，告诉我哪个区域增长最快', '继续'],
    });
    expect(withExplicitHighlights.worthKnowledge).toEqual(['对比四大区 Q3 环比增速并提炼三条核心变化']);
  });
});
