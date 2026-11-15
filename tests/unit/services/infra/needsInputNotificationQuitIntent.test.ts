// ============================================================================
// Fallback B（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1 ③）：needs_input 通知在退出意图
// 为 background 时额外弹 host 侧原生通知（renderer toast 不随壳退出存活）。
// 注入发送器断言：只在 background 弹；none/stop 不弹；发送器抛错不炸通知主路径。
// 意图状态机没有复位到 none 的入口——用例按序先测「非 background」再切 background。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARKED_APPROVAL_ENTRY_PATH } from '../../../../src/shared/parkedApprovalLocation';

const platformMocks = vi.hoisted(() => ({
  focusedWindow: null as object | null,
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
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));

const { notificationService } =
  await import('../../../../src/host/services/infra/notificationService');
const { getDaemonQuitIntent, setDaemonQuitIntent } =
  await import('../../../../src/host/services/daemon/quitIntent');

const nativeSender = vi.fn();

beforeEach(() => {
  platformMocks.focusedWindow = null;
  platformMocks.broadcast.mockClear();
  platformMocks.info.mockClear();
  nativeSender.mockClear();
  notificationService.clearRecentNotifications();
  notificationService.setNativeNotificationSender(nativeSender);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('needs-input 原生通知兜底（fallback B）', () => {
  it('退出意图非 background（初始 none / stop）时不弹原生通知', () => {
    expect(getDaemonQuitIntent()).not.toBe('background');
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '有操作等你确认', body: '无人值守任务请求执行 write_file' });
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(nativeSender).not.toHaveBeenCalled();

    setDaemonQuitIntent('stop');
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '有操作等你确认', body: '正文' });
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(2);
    expect(nativeSender).not.toHaveBeenCalled();
  });

  it('background（壳声明后台继续后退出）时额外弹一条固定文案的原生通知', () => {
    setDaemonQuitIntent('background');
    notificationService.notifyNeedsInput({
      sessionId: 's1',
      title: '有操作等你确认',
      body: `无人值守任务请求执行 write_file，已暂停等你批准，到${PARKED_APPROVAL_ENTRY_PATH}处理。`,
    });
    // renderer toast 照发（壳重开后仍有落点）+ host 原生兜底
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(nativeSender).toHaveBeenCalledTimes(1);
    expect(nativeSender).toHaveBeenCalledWith({
      id: platformMocks.broadcast.mock.calls[0][1].id,
      sessionId: 's1',
      title: '有事项需要你确认',
      body: '后台任务在等你确认，打开 Agent Neo 处理。',
    });
  });

  it('原生通知文案不带工具名（不复制调用方 title/body）', () => {
    setDaemonQuitIntent('background');
    notificationService.notifyNeedsInput({
      sessionId: 's1',
      title: '有操作等你确认',
      body: '无人值守任务请求执行 mcp__feishu__sendMessage',
    });
    const payload = nativeSender.mock.calls[0]?.[0] as { title: string; body: string };
    expect(payload.body).not.toContain('mcp__');
    expect(payload.body).not.toContain('sendMessage');
  });

  it('发送器抛错不炸通知主路径（renderer toast 照发）', () => {
    setDaemonQuitIntent('background');
    nativeSender.mockImplementation(() => { throw new Error('osascript missing'); });
    expect(() => notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b' })).not.toThrow();
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
  });

  it('恢复默认发送器（注入 null）后不再走替身', () => {
    setDaemonQuitIntent('background');
    notificationService.setNativeNotificationSender(null);
    // Restoring the default must stop using the injected sender.
    expect(() => notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b' })).not.toThrow();
    expect(nativeSender).not.toHaveBeenCalled();
    notificationService.setNativeNotificationSender(nativeSender);
  });

  it('焦点策略（main #2679 语义）：needs_input 一律 urgent 绕焦点门，原生兜底仍只由 quit-intent 决定', () => {
    // 本单曾钉「聚焦时整体不发」；main #2679 改为 needs_input 一律 urgent——用户在看
    // 别的会话也不能错过等输入。合并后以 main 语义为准，兜底门槛（quit-intent）不变。
    setDaemonQuitIntent('background');
    platformMocks.focusedWindow = {};
    notificationService.notifyNeedsInput({ sessionId: 's1', title: 't', body: 'b' });
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(nativeSender).toHaveBeenCalledTimes(1);
  });

  it('原生兜底只挂在 needs_input 上：任务完成通知在 background 下不弹原生', () => {
    setDaemonQuitIntent('background');
    notificationService.notifyTaskComplete({
      sessionId: 's1', sessionTitle: '日报', duration: 1000, toolsUsed: [], succeeded: true,
    }, { force: true });
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(nativeSender).not.toHaveBeenCalled();
  });

  it('CODE_AGENT_NOTIFICATION_DRY_RUN=1 + background 时只记录不弹原生通知（记 dry-run 跳过日志）', () => {
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
    setDaemonQuitIntent('background');
    notificationService.notifyNeedsInput({
      sessionId: 's1',
      title: '有操作等你确认',
      body: '无人值守任务请求执行 write_file',
    });
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(0);
    expect(nativeSender).toHaveBeenCalledTimes(0);
    expect(notificationService.getRecentNotifications()).toEqual([
      expect.objectContaining({ sessionId: 's1', type: 'needs_input', delivery: 'dry_run' }),
    ]);
    expect(platformMocks.info).toHaveBeenCalledWith('Native needs-input notification skipped', {
      reason: 'dry-run',
    });
  });

  it('未开启 dry-run（CODE_AGENT_NOTIFICATION_DRY_RUN 为空）+ background 时照常调用一次原生发送器', () => {
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '');
    nativeSender.mockImplementation(() => {});
    setDaemonQuitIntent('background');
    notificationService.notifyNeedsInput({
      sessionId: 's1',
      title: '有操作等你确认',
      body: '无人值守任务请求执行 write_file',
    });
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(nativeSender).toHaveBeenCalledTimes(1);
    expect(platformMocks.info).not.toHaveBeenCalledWith('Native needs-input notification skipped', {
      reason: 'dry-run',
    });
  });
});
