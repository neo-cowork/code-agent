// 「交给 Neo」首句（N-MEETING-PAGE ③，爸 11-15 定）：要带会议名、原话出处、meeting_records 提示，不能只有事项本身
import { describe, expect, it } from 'vitest';
import { buildMeetingActionSeed } from '../../../src/renderer/utils/startMeetingActionTask';

const meeting = { id: 'meeting-1794', title: '礼品中心架构评审', startedAtMs: new Date(2026, 9, 30, 15, 6).getTime() };

describe('交给 Neo 的首句', () => {
  it('带会议名和时间、事项、原话、meeting_records 提示', () => {
    const seed = buildMeetingActionSeed(meeting, { text: '修改礼品中心原型图', quote: '原型图要改，取消场景层', owner: '我', due: '周五' });
    expect(seed).toContain('会议「礼品中心架构评审」（10月30日 15:06）');
    expect(seed).toContain('修改礼品中心原型图');
    expect(seed).toContain('原话：「原型图要改，取消场景层」');
    expect(seed).toContain('负责人：我；截止：周五');
    expect(seed).toContain('可用 meeting_records 查这场会（meeting_id: meeting-1794）');
  });

  it('原话没说负责人 / 截止：写「会上没定」，不替会上的人拍板', () => {
    const seed = buildMeetingActionSeed(meeting, { text: '确认履约方式', quote: '要跟强哥再确认一下', owner: null, due: null });
    expect(seed).toContain('负责人：会上没定；截止：会上没定');
  });
});
