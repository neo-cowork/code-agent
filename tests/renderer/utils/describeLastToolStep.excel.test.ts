import { describe, expect, it } from 'vitest';
import { describeLastToolStep } from '../../../src/renderer/utils/agentActivity';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { extractToolStepAction } from '../../../src/host/agent/toolStepTarget';

describe('后台代理活动行里的 ExcelAutomate（N-FIX-EXCEL-READ-APPROVAL-PER-CALL）', () => {
  const target = '/contracts/01-装修工程合同.xlsx';
  it('read → 读取 / Read，edit → 写入 / Write，不再是「执行了工具操作」', () => {
    for (const [action, zhText, enText] of [['read', '读取', 'Read'], ['edit', '写入', 'Write']] as const) {
      const step = { tool: 'ExcelAutomate', target, action, at: 1 };
      expect(describeLastToolStep(step, zh)).toContain(zhText);
      expect(describeLastToolStep(step, zh)).not.toContain('执行了工具操作');
      expect(describeLastToolStep(step, en)).toContain(enText);
    }
    expect(describeLastToolStep({ tool: 'ExcelAutomate', target, action: 'read', at: 1 }, zh)).toContain('01-装修工程合同.xlsx');
  });
  it('host 只取短字符串 action', () => {
    expect(extractToolStepAction({ action: 'read' })).toBe('read');
    expect(extractToolStepAction({ action: 'x'.repeat(40) })).toBeUndefined();
    expect(extractToolStepAction({ action: 3 })).toBeUndefined();
  });
});
