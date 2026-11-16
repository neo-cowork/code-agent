import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

describe('决策动作基底词', () => {
  it('中文以场景词开头、允许/拒绝收口', () => {
    expect(zh.decisionCard.swarm.optionApprove).toBe('启动');
    expect(zh.decisionCard.swarm.optionReject).toBe('取消');
    expect(zh.decisionCard.workflow.optionApprove).toBe('启动');
    expect(zh.planApproval.approve).toBe('按此计划执行');
    expect(zh.planApproval.cancel).toBe('取消');
    expect(zh.userQuestion.submit).toBe('提交回答');
    expect(zh.userQuestion.skip).toBe('跳过');
    expect(zh.design.proposalApply).toBe('画布修改 · 允许');
    expect(zh.design.proposalReject).toBe('画布修改 · 拒绝');
  });

  it('英文与中文同一套标准动词（画布修改暂保留场景词）', () => {
    expect(en.decisionCard.swarm.optionApprove).toBe('Launch');
    expect(en.decisionCard.swarm.optionReject).toBe('Cancel');
    expect(en.planApproval.approve).toBe('Run this plan');
    expect(en.planApproval.cancel).toBe('Cancel');
    expect(en.userQuestion.submit).toBe('Submit answer');
    expect(en.userQuestion.skip).toBe('Skip');
    const wb = en.decisionCard.permission.writeback;
    expect([wb.optionDeny, wb.optionDenyMeeting, wb.optionDenyCreate, wb.optionDenyUpdate, wb.optionDenyDelete]).toEqual(Array(5).fill('Cancel'));
    expect([wb.sendEdited, wb.createEdited, wb.updateEdited]).toEqual(['Send edited version', 'Create edited version', 'Update edited version']);
    expect(en.design.proposalApply).toBe('Canvas edit · Allow');
    expect(en.design.proposalReject).toBe('Canvas edit · Deny');
  });
});
