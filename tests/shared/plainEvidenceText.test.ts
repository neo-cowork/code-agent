// ============================================================================
// plainEvidenceText — 醒来 evidence 人话化：不得带 / 路径、.md、反引号
// ============================================================================

import { describe, expect, it } from 'vitest';
import { plainEvidenceText } from '../../src/shared/plainEvidenceText';

describe('plainEvidenceText', () => {
  it('reduces a backticked relative path to basename without extension', () => {
    expect(plainEvidenceText('`workspace/weekly/2026-W46.md`')).toBe('2026-W46');
  });

  it('reduces absolute paths (unix home / windows drive) to basename without extension', () => {
    expect(plainEvidenceText('/Users/alice/work/workspace/weekly/2026-W46.md')).toBe('2026-W46');
    expect(plainEvidenceText('~/Documents/notes.md')).toBe('notes');
    expect(plainEvidenceText('C:\\work\\logs\\run.log')).toBe('run');
  });

  it('strips bare backticks around prose', () => {
    expect(plainEvidenceText('`该跟进周报`')).toBe('该跟进周报');
    expect(plainEvidenceText('**重点** 和 __次重点__')).toBe('重点 和 次重点');
  });

  it('keeps markdown link label and drops the link target', () => {
    expect(plainEvidenceText('[周报](workspace/weekly/2026-W46.md)')).toBe('周报');
    expect(plainEvidenceText('见 [第46周](workspace/weekly/2026-W46.md) 的内容')).toBe('见 第46周 的内容');
  });

  it('strips the doc extension from bare filenames', () => {
    expect(plainEvidenceText('history.md · 周报.md')).toBe('history · 周报');
  });

  it('returns ordinary Chinese prose byte-identical', () => {
    const prose = '履历里的周报已经连续两周没更新';
    expect(plainEvidenceText(prose)).toBe(prose);
    expect(plainEvidenceText('参考了上次会话的结论和记忆条目')).toBe('参考了上次会话的结论和记忆条目');
  });

  it('collapses whitespace and returns empty string for blank input', () => {
    expect(plainEvidenceText('  a  \n b  ')).toBe('a b');
    expect(plainEvidenceText('')).toBe('');
    expect(plainEvidenceText('   \n  ')).toBe('');
  });

  it('result never keeps a joined path, a .md suffix, or a backtick', () => {
    const out = plainEvidenceText('依据 `workspace/weekly/2026-W46.md` 与 /Users/alice/x/notes.md');
    expect(out).not.toContain('/');
    expect(out).not.toContain('.md');
    expect(out).not.toContain('`');
  });

  it('keeps single-slash abbreviations and ratios untouched', () => {
    for (const text of ['CI/CD 流水线两周没跑', '评分 4.5/5', 'A/B 实验结果未出', 'I/O 延迟升高', '版本 v1.2/v1.3 对比']) {
      expect(plainEvidenceText(text)).toBe(text);
    }
  });

  it('still reduces real paths next to abbreviations', () => {
    expect(plainEvidenceText('CI/CD 日志见 `workspace/weekly/2026-W46.md`')).toBe('CI/CD 日志见 2026-W46');
    expect(plainEvidenceText('读了 ./notes/a.md 和 ~/x/b')).toBe('读了 a 和 b');
  });

  it('keeps unspaced CJK-adjacent abbreviations, ratios and dates verbatim (r2)', () => {
    // 复判 r2：无空格时不得吞掉「中文+CI/」整段——化简只发生在明确像文件路径的 token 上
    expect(plainEvidenceText('周会CI/CD流水线两周没跑')).toBe('周会CI/CD流水线两周没跑');
    expect(plainEvidenceText('CI/CD流水线两周没跑')).toBe('CI/CD流水线两周没跑');
    expect(plainEvidenceText('跑CI/CD流水线')).toBe('跑CI/CD流水线');
    expect(plainEvidenceText('覆盖率评分4.5/5')).toBe('覆盖率评分4.5/5');
    expect(plainEvidenceText('评分4.5/5')).toBe('评分4.5/5');
    expect(plainEvidenceText('A/B实验结果未出')).toBe('A/B实验结果未出');
    expect(plainEvidenceText('在2026/11/20核对过')).toBe('在2026/11/20核对过');
    expect(plainEvidenceText('检查工作区/weekly 进度')).toBe('检查工作区/weekly 进度');
  });

  it('keeps unspaced CJK words glued to a real path; simplifies only the path part (r3)', () => {
    // 复判 r3：反引号剥掉后中文紧贴 ASCII 路径（无空格），前导中文是动词/主语，不许丢
    expect(plainEvidenceText('已核对`workspace/weekly/status`')).toBe('已核对status');
    expect(plainEvidenceText('见`workspace/weekly/2026-W46.md`')).toBe('见2026-W46');
    expect(plainEvidenceText('检查工作区/周报.md 是否更新')).toBe('检查工作区周报 是否更新');
    expect(plainEvidenceText('工作区/weekly/2026-W46.md')).toBe('工作区2026-W46');
  });

  it('leaves ambiguous CJK slash text unchanged rather than dropping words (r3)', () => {
    // 『weekly/x』与『CI/CD』结构同形，分不出中文目录名还是缩写 → 基线是原样保留，不丢词
    expect(plainEvidenceText('工作区/weekly/x 目录里')).toBe('工作区/weekly/x 目录里');
    expect(plainEvidenceText('他/她 都可以')).toBe('他/她 都可以');
    expect(plainEvidenceText('一/二/三 的比例')).toBe('一/二/三 的比例');
  });
});
