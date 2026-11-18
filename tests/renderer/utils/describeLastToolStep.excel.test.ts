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

describe('Excel call labels share host action categories', () => {
  it('shows the exact read/write filename and prefers the generate destination', async () => {
    const { humanizeToolStep } = await import('../../../src/renderer/utils/humanizeToolStep');
    const { EXCEL_READ_ACTIONS, EXCEL_WRITE_ACTIONS } = await import('../../../src/shared/constants/excelActions');
    for (const action of EXCEL_READ_ACTIONS) {
      expect(humanizeToolStep('ExcelAutomate', { action, file_path: '/contracts/04-物业服务合同.xlsx' }, zh)).toBe('读取 04-物业服务合同.xlsx');
    }
    for (const action of EXCEL_WRITE_ACTIONS) {
      const args = { action, file_path: '/contracts/source.xlsx', output_path: '/work/汇总.xlsx' };
      expect(humanizeToolStep('ExcelAutomate', args, zh)).toBe(`写入 ${action === 'generate' ? '汇总.xlsx' : 'source.xlsx'}`);
    }
  });
});


it('helper generate activity names the written destination when an unused input path is also present', async () => {
  const { extractToolStepTarget } = await import('../../../src/host/agent/toolStepTarget');
  const args = { action: 'generate', file_path: '/contracts/source.xlsx', output_path: '/work/汇总.xlsx' };
  const target = extractToolStepTarget(args, 'ExcelAutomate');
  expect(target).toBe(args.output_path);
  expect(describeLastToolStep({ tool: 'ExcelAutomate', action: args.action, target, at: 1 }, zh)).toBe('写入 汇总.xlsx');
});
