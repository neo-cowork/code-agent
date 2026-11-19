// ============================================================================
// plainWakeSummary 复发门：suggest/report 摘要不得带表格符号、标题记号、分隔线或路径形状
// ============================================================================

import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { plainWakeSummary } from '../../../../src/host/services/roleAssets/wakeRationale';

const HOSTILE: Array<[string, string, string?]> = [
  ['table-only', '| 检查项 | 结论 |\n|---|---|\n| a | b |', '周报已检查，无需处理。'],
  ['heading+table', '## 实测现状\n| 检查项 | 结论 |\n|---|---|\n| `workspace/weekly/weekly-47.md` | 通过 |\n\n巡检完成，没有动文件。'],
  ['absolute path', '已读取 /Users/leo/work/workspace/weekly/weekly-47.md，内容完整。'],
  ['~/ path', '备份写到 ~/.code-agent/backup/notes.md 和 ~/Documents/a.txt 了。'],
  ['fenced code', '```bash\ncat workspace/weekly/weekly-47.md | head\n---\n```\n检查完了，两份周报都在。'],
  ['CJK prose + relative path', '**周报**已生成：见 [周报](workspace/weekly/weekly-47.md) 与 `workspace/weekly/weekly-46.md`。第二句。第三句不应出现。'],
  ['flattened table row', '| ## 实测现状 | | 检查项 | 结论 | | |---|---| | | `workspace/weekly/weekly-47.md` | 通过 |', '周报检查完成。'],
];

describe('plainWakeSummary recurrence gate', () => {
  it.each(HOSTILE)('hostile sample %s: no table, heading, separator or path shapes', (_name, text, rationale) => {
    const out = plainWakeSummary(text, rationale);
    expect(out).not.toMatch(/^\s*\|/m);
    expect(out).not.toContain('|');
    expect(out).not.toContain('##');
    expect(out).not.toContain('---');
    expect(out).not.toMatch(/[\w.~-]+\/[\w./-]+\.\w+/);
    expect(out).not.toMatch(/(?:^|\s)(?:~|\.{0,2})\/[\w.-]+/);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('keeps only the basename of a mentioned file and at most two sentences', () => {
    expect(plainWakeSummary('**周报**已生成：见 [周报](workspace/weekly/weekly-47.md)。第二句。第三句不应出现。'))
      .toBe('周报已生成：见 周报。第二句。');
    expect(plainWakeSummary('写入 workspace/weekly/weekly-47.md 完成。')).toBe('写入 weekly-47.md 完成。');
  });

  it('table-only text yields empty without a rationale, so callers use their existing fallback copy', () => {
    expect(plainWakeSummary('| a | b |\n|---|---|')).toBe('');
  });

  it('the wake loop actually routes summary through plainWakeSummary (bypass fails this gate)', () => {
    const src = readFileSync('src/host/services/roleAssets/roleProactivity.ts', 'utf8');
    expect(src).toMatch(/summary = plainWakeSummary\(/);
    expect(src).not.toMatch(/wakeText\.slice\(/);
  });
});
