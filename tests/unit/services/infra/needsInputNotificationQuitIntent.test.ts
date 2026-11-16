// ============================================================================
// Fallback B（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1 ③）：needs_input 通知在退出意图
// 为 background 时额外弹 host 侧原生通知（renderer toast 不随壳退出存活）。
// 注入发送器断言：只在 background 弹；none/stop 不弹；发送器抛错不炸通知主路径。
// 意图状态机没有复位到 none 的入口——用例按序先测「非 background」再切 background。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEEDS_INPUT_NATIVE_FALLBACK } from '../../../../src/shared/constants/timeouts';
import { PARKED_APPROVAL_ENTRY_PATH } from '../../../../src/shared/parkedApprovalLocation';

const platformMocks = vi.hoisted(() => ({
  focusedWindow: null as object | null,
  language: 'zh' as 'zh' | 'en',
  broadcast: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => platformMocks.focusedWindow },
  broadcastToRenderer: platformMocks.broadcast,
}));
vi.mock('../../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: platformMocks.info, warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: platformMocks.language } }) }),
}));

const { notificationService } =
  await import('../../../../src/host/services/infra/notificationService');
const { getDaemonQuitIntent, setDaemonQuitIntent } =
  await import('../../../../src/host/services/daemon/quitIntent');

const nativeSender = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  platformMocks.language = 'zh';
  platformMocks.focusedWindow = null;
  platformMocks.broadcast.mockClear();
  platformMocks.info.mockClear();
  nativeSender.mockReset();
  notificationService.clearRecentNotifications();
  notificationService.setNativeNotificationSender(nativeSender);
  notificationService.setNotificationSessionTitleResolver(async () => '会议纪要');
});

afterEach(() => {
  notificationService.clearRecentNotifications();
  notificationService.setNotificationSessionTitleResolver(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('needs-input 原生通知兜底（fallback B）', () => {
  it('退出意图非 background（初始 none / stop）时不弹原生通知', async () => {
    expect(getDaemonQuitIntent()).not.toBe('background');
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '有操作等你确认', body: '无人值守任务请求执行 write_file' });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(nativeSender).not.toHaveBeenCalled();

    setDaemonQuitIntent('stop');
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '有操作等你确认', body: '正文' });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(2);
    expect(nativeSender).not.toHaveBeenCalled();
  });

  it('background（壳声明后台继续后退出）时按任务和动作弹一条原生通知', async () => {
    setDaemonQuitIntent('background');
    notificationService.notifyNeedsInput({
      sessionId: 's1',
      title: '有操作等你确认',
      body: `无人值守任务请求执行 write_file，已暂停等你批准，到${PARKED_APPROVAL_ENTRY_PATH}处理。`,
    });
    // renderer toast 照发（壳重开后仍有落点）+ host 原生兜底
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(nativeSender).toHaveBeenCalledTimes(1);
    expect(nativeSender).toHaveBeenCalledWith({
      id: platformMocks.broadcast.mock.calls[0][1].id,
      sessionId: 's1',
      title: '会议纪要',
      body: '等你确认：操作',
    });
  });

  it('原生通知文案不带工具名（不复制调用方 title/body）', async () => {
    setDaemonQuitIntent('background');
    notificationService.notifyNeedsInput({
      sessionId: 's1',
      title: '有操作等你确认',
      body: '无人值守任务请求执行 mcp__feishu__sendMessage',
    });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    const payload = nativeSender.mock.calls[0]?.[0] as { title: string; body: string };
    expect(payload.body).not.toContain('mcp__');
    expect(payload.body).not.toContain('sendMessage');
  });

  it('发送器抛错不炸通知主路径（renderer toast 照发）', async () => {
    setDaemonQuitIntent('background');
    nativeSender.mockImplementation(() => { throw new Error('osascript missing'); });
    expect(() => notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b' })).not.toThrow();
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
  });

  it('恢复默认发送器（注入 null）后不再走替身', async () => {
    setDaemonQuitIntent('background');
    notificationService.setNativeNotificationSender(null);
    // Restoring the default must stop using the injected sender.
    expect(() => notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b' })).not.toThrow();
    expect(nativeSender).not.toHaveBeenCalled();
    notificationService.setNativeNotificationSender(nativeSender);
  });

  it('焦点策略（main #2679 语义）：needs_input 一律 urgent 绕焦点门，原生兜底仍只由 quit-intent 决定', async () => {
    // 本单曾钉「聚焦时整体不发」；main #2679 改为 needs_input 一律 urgent——用户在看
    // 别的会话也不能错过等输入。合并后以 main 语义为准，兜底门槛（quit-intent）不变。
    setDaemonQuitIntent('background');
    platformMocks.focusedWindow = {};
    notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b' });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(nativeSender).toHaveBeenCalledTimes(1);
  });

  it('原生兜底只挂在 needs_input 上：任务完成通知在 background 下不弹原生', async () => {
    setDaemonQuitIntent('background');
    notificationService.notifyTaskComplete({
      sessionId: 's1', sessionTitle: '日报', duration: 1000, toolsUsed: [], succeeded: true,
    }, { force: true });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(nativeSender).not.toHaveBeenCalled();
  });

  it('CODE_AGENT_NOTIFICATION_DRY_RUN=1 + background 时只记录不弹原生通知（记 dry-run 跳过日志）', async () => {
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
    setDaemonQuitIntent('background');
    notificationService.notifyNeedsInput({
      sessionId: 's1',
      title: '有操作等你确认',
      body: '无人值守任务请求执行 write_file',
    });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(0);
    expect(nativeSender).toHaveBeenCalledTimes(0);
    expect(notificationService.getRecentNotifications()).toEqual([
      expect.objectContaining({ sessionId: 's1', type: 'needs_input', delivery: 'dry_run' }),
    ]);
    expect(platformMocks.info).toHaveBeenCalledWith('Native needs-input notification skipped', {
      reason: 'dry-run',
      id: expect.any(String), sessionId: 's1', title: '会议纪要', body: '等你确认：操作',
    });
  });

  it('未开启 dry-run（CODE_AGENT_NOTIFICATION_DRY_RUN 为空）+ background 时照常调用一次原生发送器', async () => {
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '');
    nativeSender.mockImplementation(() => {});
    setDaemonQuitIntent('background');
    notificationService.notifyNeedsInput({
      sessionId: 's1',
      title: '有操作等你确认',
      body: '无人值守任务请求执行 write_file',
    });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(nativeSender).toHaveBeenCalledTimes(1);
    expect(platformMocks.info).not.toHaveBeenCalledWith('Native needs-input notification skipped', {
      reason: 'dry-run',
      id: expect.any(String), sessionId: 's1', title: '会议纪要', body: '等你确认：操作',
    });
  });

  it('12 needs_input calls with distinct keys produce exactly 1 native banner (12→1)', async () => {
    setDaemonQuitIntent('background');
    platformMocks.language = 'en';
    for (let i = 0; i < 12; i++) notificationService.notifyNeedsInput({
      sessionId: 's1', title: 'Write', body: '/private/raw-argument', tool: 'write_file', dedupeKey: `approval-${i}`,
    });
    expect(nativeSender).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS - 1);
    expect(nativeSender).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(nativeSender).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String), sessionId: 's1', title: '会议纪要', body: '12 actions are waiting for your confirmation',
    });
    console.info('ASSERT 12→1:', JSON.stringify(nativeSender.mock.calls));
  });

  it('12 keyed and 3 keyless calls fold together; later calls stay quiet', async () => {
    setDaemonQuitIntent('background');
    for (let i = 0; i < 12; i++) {
      const data = { sessionId: 's1', title: 'Write', body: 'raw', tool: 'Write', dedupeKey: `approval-${i}` };
      notificationService.notifyNeedsInput(data);
      notificationService.notifyNeedsInput(data); // duplicates do not inflate the count
    }
    for (let i = 0; i < 3; i++) notificationService.notifyNeedsInput({ sessionId: 's1', title: 'AskUserQuestion', body: 'raw' });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(nativeSender).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 's1', body: '15 项操作等你确认' }));
    notificationService.notifyNeedsInput({ sessionId: 's1', title: 'Write', body: 'raw', dedupeKey: 'later' });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(nativeSender).toHaveBeenCalledTimes(1);
    expect(platformMocks.info).toHaveBeenCalledWith('Native needs-input notification skipped', { reason: 'native-folded', sessionId: 's1' });
  });

  it.each(['zh', 'en'] as const)('three sessions keep their own title, action and click sessionId (%s)', async (language) => {
    platformMocks.language = language;
    setDaemonQuitIntent('background');
    const titles = ['Meeting summary', 'Photo selection', 'Project update'];
    const tools = ['Write', 'Edit', 'Bash'];
    const actions = language === 'en' ? ['Write file', 'Edit file', 'Run command'] : ['写入文件', '编辑文件', '运行命令'];
    notificationService.setNotificationSessionTitleResolver(async (id) => titles[Number(id.slice(-1))]);
    tools.forEach((tool, i) => notificationService.notifyNeedsInput({ sessionId: `session-${i}`, title: 'mcp__raw', body: 'approval-secret /raw/arguments', tool, dedupeKey: `approval-${i}` }));
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(nativeSender).toHaveBeenCalledTimes(3);
    nativeSender.mock.calls.forEach(([payload], i) => {
      expect(payload).toEqual({ id: expect.any(String), sessionId: `session-${i}`, title: titles[i], body: language === 'en' ? `Waiting for your OK: ${actions[i]}` : `等你确认：${actions[i]}` });
      for (const forbidden of ['mcp__', 'approval-', '/raw/', 'Bash', 'Write"', 'Edit"']) expect(JSON.stringify({ title: payload.title, body: payload.body })).not.toContain(forbidden);
    });
    console.info(`ASSERT ${language} payloads:`, JSON.stringify(nativeSender.mock.calls));
  });

  it('retract all keyed items reopens the session for a fresh banner', async () => {
    setDaemonQuitIntent('background');
    for (const key of ['first', 'second']) notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b', tool: 'Write', dedupeKey: key });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    notificationService.retractNeedsInput('first');
    notificationService.retractNeedsInput('second');
    notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b', tool: 'Edit', dedupeKey: 'new' });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(nativeSender).toHaveBeenCalledTimes(2);
    expect(nativeSender.mock.calls[1][0].body).toBe('等你确认：编辑文件');
  });

  it('retract during fold removes resolved items, including in dry-run mode', async () => {
    setDaemonQuitIntent('background');
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
    notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b', tool: 'Write', dedupeKey: 'resolved' });
    notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b', tool: 'Edit', dedupeKey: 'pending' });
    notificationService.retractNeedsInput('resolved');
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(platformMocks.info).toHaveBeenCalledWith('Native needs-input notification skipped', expect.objectContaining({ reason: 'dry-run', body: '等你确认：编辑文件' }));
    notificationService.retractNeedsInput('pending');
    notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b', tool: 'Write', dedupeKey: 'fresh' });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(platformMocks.info).toHaveBeenCalledWith('Native needs-input notification skipped', expect.objectContaining({ reason: 'dry-run', body: '等你确认：写入文件' }));
  });

  it('keyless items keep a session quiet until the quiet period after the last call', async () => {
    setDaemonQuitIntent('background');
    const data = { sessionId: 's1', title: 't', body: 'b' };
    notificationService.notifyNeedsInput(data);
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    notificationService.notifyNeedsInput({ ...data, dedupeKey: 'keyed' });
    notificationService.retractNeedsInput('keyed');
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.QUIET_PERIOD_MS - 1);
    expect(nativeSender).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    notificationService.notifyNeedsInput(data);
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(nativeSender).toHaveBeenCalledTimes(2);
  });

  it.each(['zh', 'en'] as const)('failed session lookup and unknown tools use safe localized fallback (%s)', async (language) => {
    setDaemonQuitIntent('background');
    platformMocks.language = language;
    notificationService.setNotificationSessionTitleResolver(async () => { throw new Error('lookup failed'); });
    notificationService.notifyNeedsInput({ sessionId: 'secret-id', title: 'mcp__internal', body: '/private/args', tool: 'unknown_internal_tool' });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    expect(nativeSender).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: language === 'en' ? 'Untitled task' : '未命名任务', body: language === 'en' ? 'Waiting for your OK: Action' : '等你确认：操作' }));
  });

  it('clear and retract-all cancel timers and title lookups in flight', async () => {
    setDaemonQuitIntent('background');
    let resolveTitle!: (title: string) => void;
    notificationService.setNotificationSessionTitleResolver(() => new Promise((resolve) => { resolveTitle = resolve; }));
    notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b', dedupeKey: 'pending' });
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
    notificationService.retractNeedsInput('pending');
    resolveTitle('Stale task');
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeSender).not.toHaveBeenCalled();
    notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b' });
    notificationService.clearRecentNotifications();
    await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.QUIET_PERIOD_MS);
    expect(nativeSender).not.toHaveBeenCalled();
  });

});
