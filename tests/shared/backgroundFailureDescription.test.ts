import { describe, expect, it } from 'vitest';
import { describeBackgroundFailure } from '../../src/shared/taskReasonLanguage';

// FB-2786：后台任务把一整段 markdown 报价清单当成失败原因
const FB_2786 = [
  '对比做不下去了，问题出在 B 那份文件上。',
  '',
  '**供应商A（可正常读取）**',
  '- 螺丝 M6：0.12 元/个',
  '- 轴承 6204：8.5 元/个',
  '- 密封圈：0.9 元/个',
  '- 交期：15 天',
  '',
  '**供应商B（读不出内容）**',
  '`供应商B报价单.xlsx` 文件名是表格格式，但里面没有有效的表格数据。',
].join('\n');

// FB-2930：余额不足 + 完整充值链接
const FB_2930 = '账户余额不足，请充值后重试。充值地址：https://tokenrhythm.studio/account/recharge';

describe('describeBackgroundFailure', () => {
  it('FB-2786: keeps only the first sentence, without markdown markers', () => {
    const result = describeBackgroundFailure(FB_2786, 'zh');
    expect(result.reason).toBe('对比做不下去了，问题出在 B 那份文件上。');
    expect(result.reason).not.toContain('*');
    expect(result.category).toBe('unknown');
    expect(result.detail).toBe(FB_2786);
  });

  it('FB-2786 variant: the first line itself is markdown', () => {
    const result = describeBackgroundFailure('## **没做完**：`供应商B报价单.xlsx` 读不出内容。\n- 细节一', 'zh');
    expect(result.reason).toBe('没做完：供应商B报价单.xlsx 读不出内容。');
  });

  it('FB-2930: drops the URL and its label, category model, detail keeps the URL', () => {
    const result = describeBackgroundFailure(FB_2930, 'zh');
    expect(result.reason).toBe('账户余额不足，请充值后重试。');
    expect(result.reason).not.toMatch(/https?:/);
    expect(result.category).toBe('model');
    expect(result.detail).toBe(FB_2930);
    expect(result.detail).toContain('https://tokenrhythm.studio/account/recharge');
  });

  it('short reason equal to raw has no detail', () => {
    expect(describeBackgroundFailure('  文件读不出来  ', 'zh')).toEqual({ reason: '文件读不出来', category: 'unknown' });
    expect(describeBackgroundFailure('The file could not be read', 'en')).toEqual({
      reason: 'The file could not be read',
      category: 'unknown',
    });
  });

  it('machine noise gives an empty reason and keeps the raw text as detail', () => {
    expect(describeBackgroundFailure('TypeError: Cannot read properties of undefined (reading \'map\')', 'en')).toEqual({
      reason: '',
      category: 'unknown',
      detail: 'TypeError: Cannot read properties of undefined (reading \'map\')',
    });
    expect(describeBackgroundFailure('getaddrinfo ENOTFOUND api.example.com', 'zh')).toEqual({
      reason: '',
      category: 'network',
      detail: 'getaddrinfo ENOTFOUND api.example.com',
    });
  });

  it('reason is empty when its script does not match the UI language', () => {
    const english = 'The supplier B file is not a real spreadsheet. Please send a new one.';
    expect(describeBackgroundFailure(english, 'zh')).toEqual({ reason: '', category: 'unknown', detail: english });
    expect(describeBackgroundFailure(english, 'en').reason).toBe('The supplier B file is not a real spreadsheet.');
    expect(describeBackgroundFailure(FB_2930, 'en')).toEqual({ reason: '', category: 'model', detail: FB_2930 });
    expect(describeBackgroundFailure(FB_2786, 'en').reason).toBe('');
  });

  it('strips links in every common form', () => {
    expect(describeBackgroundFailure('Insufficient balance. Recharge at: https://example.com/pay?x=1', 'en')).toMatchObject({
      reason: 'Insufficient balance.',
      category: 'model',
    });
    expect(describeBackgroundFailure('登录已过期，请到[账号页](https://example.com/account)重新登录。', 'zh').reason)
      .toBe('登录已过期，请到账号页重新登录。');
    expect(describeBackgroundFailure('详情：https://example.com/a', 'zh')).toEqual({
      reason: '',
      category: 'unknown',
      detail: '详情：https://example.com/a',
    });
    expect(describeBackgroundFailure('没能连上服务（https://example.com/api），稍后再试。', 'zh').reason)
      .toBe('没能连上服务，稍后再试。');
  });

  it('skips table rows and rules when picking the first sentence', () => {
    const table = '| 检查项 | 结果 |\n|---|---|\n| 文件名 | 供应商B报价单.xlsx |\n\n---\n\n文件开头不是表格文件应有的标记。后面还有别的说明。';
    expect(describeBackgroundFailure(table, 'zh').reason).toBe('文件开头不是表格文件应有的标记。');
    expect(describeBackgroundFailure('| a | b |\n|---|---|\n| 1 | 2 |', 'en')).toMatchObject({ reason: '', category: 'unknown' });
  });

  it('a very long log still yields its opening sentence and keeps the whole text as detail', () => {
    const long = `没能读出报价单。\n${'at step (worker.js:1:1)\n'.repeat(4000)}`;
    const result = describeBackgroundFailure(long, 'zh');
    expect(result.reason).toBe('没能读出报价单。');
    expect(result.detail).toBe(long.trim());
  });

  it('does not split a sentence on a decimal point', () => {
    expect(describeBackgroundFailure('Price 0.12 per unit could not be checked. More text', 'en').reason)
      .toBe('Price 0.12 per unit could not be checked.');
  });

  it('empty input', () => {
    expect(describeBackgroundFailure('   ', 'zh')).toEqual({ reason: '', category: 'unknown' });
  });
});
