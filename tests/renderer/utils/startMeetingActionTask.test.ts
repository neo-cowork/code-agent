// 「交给 Neo」（N-MEETING-PAGE ③，爸 11-15 定）：关掉资料库 → 新会话 → 首句带会议名、原话出处、meeting_records 提示
import { beforeEach, describe, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({ setShowLibraryPanel: vi.fn(), setPendingRoleChatSeed: vi.fn() }));
const sessions = vi.hoisted(() => ({ createSession: vi.fn(async (_title: string) => ({ id: 's-new' }) as { id: string } | null) }));
vi.mock('../../../src/renderer/stores/appStore', () => ({ useAppStore: { getState: () => app } }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({ useSessionStore: { getState: () => sessions } }));

import { startMeetingActionTask } from '../../../src/renderer/utils/startMeetingActionTask';

const meeting = {
  id: 'meeting-1794', title: '礼品中心架构评审', startedAtMs: new Date(2026, 9, 30, 15, 6).getTime(),
  endedAtMs: null, state: 'ended' as const, endReason: null, source: 'recorded' as const,
  externalRef: null, minutesState: 'done' as const, minutes: null, minutesSessionId: null,
};

beforeEach(() => { vi.clearAllMocks(); });

describe('交给 Neo', () => {
  it('关资料库、以事项为标题新建会话，首句带会议名和时间、事项、原话、meeting_records 提示', async () => {
    await startMeetingActionTask(meeting, { text: '修改礼品中心原型图', quote: '原型图要改，取消场景层', owner: '我', due: '周五' });
    expect(app.setShowLibraryPanel).toHaveBeenCalledWith(false);
    expect(sessions.createSession).toHaveBeenCalledWith('修改礼品中心原型图');
    const seed = app.setPendingRoleChatSeed.mock.calls[0][0] as string;
    expect(seed).toContain('会议「礼品中心架构评审」（10月30日 15:06）');
    expect(seed).toContain('修改礼品中心原型图');
    expect(seed).toContain('原话：「原型图要改，取消场景层」');
    expect(seed).toContain('负责人：我；截止：周五');
    expect(seed).toContain('可用 meeting_records 查这场会（meeting_id: meeting-1794）');
  });

  it('原话没说负责人 / 截止：写「会上没定」，不替会上的人拍板', async () => {
    await startMeetingActionTask(meeting, { text: '确认履约方式', quote: '要跟强哥再确认一下', owner: null, due: null });
    expect(app.setPendingRoleChatSeed.mock.calls[0][0]).toContain('负责人：会上没定；截止：会上没定');
  });

  it('会话没建成就不发种子', async () => {
    sessions.createSession.mockResolvedValueOnce(null);
    await startMeetingActionTask(meeting, { text: 'x', quote: 'y', owner: null, due: null });
    expect(app.setPendingRoleChatSeed).not.toHaveBeenCalled();
  });
});
