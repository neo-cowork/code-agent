// ============================================================================
// N-FIX-SESSION-TITLE-REVERTS-TO-RAW-MESSAGE-FU1 — web 构建实际使用 cli/session.ts 的
// SessionManager（智能标题 / 改名都经它的 updateSession）；标题变更必须回写云端行。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.hoisted(() => vi.fn());
const cliDatabase = vi.hoisted(() => ({ isInitialized: true, getSession: vi.fn(), updateSession: vi.fn() }));
const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('../../../src/cli/database', () => ({ getCLIDatabase: () => cliDatabase }));
vi.mock('../../../src/host/services/infra/sessionTitleCloudPush', () => ({ pushSessionTitleToCloud: push }));
vi.mock('../../../src/host/services/serviceRegistry', () => ({ getServiceRegistry: () => ({ register: vi.fn() }) }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: loggerMock,
  createLogger: () => loggerMock,
}));
vi.mock('../../../src/host/telemetry', () => ({ getTelemetryCollector: () => ({ updateSessionTitle: vi.fn() }) }));

const { CLISessionManager } = await import('../../../src/cli/session');

describe('CLI SessionManager.updateSession 标题回写云端', () => {
  beforeEach(() => vi.clearAllMocks());

  it('标题变更（智能标题 / 改名）回写云端行', async () => {
    await new CLISessionManager().updateSession('s1', { title: '小星的自我介绍' });
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('s1', '小星的自我介绍'));
  });

  it('非标题更新 / 空标题不回写', async () => {
    const manager = new CLISessionManager();
    await manager.updateSession('s1', { status: 'archived' });
    await manager.updateSession('s1', { title: '  ' });
    await new Promise((r) => setTimeout(r, 30));
    expect(push).not.toHaveBeenCalled();
  });

  it('push 调用抛错：fail-open 本地改名不受影响，warn 留痕 push call threw', async () => {
    push.mockImplementationOnce(() => {
      throw new Error('push boom');
    });
    await new CLISessionManager().updateSession('s-throw', { title: '改名仍成功' });
    expect(cliDatabase.updateSession).toHaveBeenCalledWith('s-throw', { title: '改名仍成功' });
    await vi.waitFor(() =>
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'session title cloud push failed: push call threw',
        expect.objectContaining({ sessionId: 's-throw', error: expect.stringContaining('push boom') }),
      ),
    );
  });

  it('推送模块导入失败：warn 留痕 module import failed，本地改名不受影响', async () => {
    vi.resetModules();
    vi.doMock('../../../src/host/services/infra/sessionTitleCloudPush', () => {
      throw new Error('import boom');
    });
    try {
      const { CLISessionManager: FreshCLISessionManager } = await import('../../../src/cli/session');
      await new FreshCLISessionManager().updateSession('s-import', { title: '改名' });
      expect(cliDatabase.updateSession).toHaveBeenCalledWith('s-import', { title: '改名' });
      await vi.waitFor(() =>
        expect(loggerMock.warn).toHaveBeenCalledWith(
          'session title cloud push failed: module import failed',
          expect.objectContaining({ sessionId: 's-import', error: expect.any(String) }),
        ),
      );
      expect(loggerMock.warn).not.toHaveBeenCalledWith(
        'session title cloud push failed: push call threw',
        expect.anything(),
      );
    } finally {
      vi.doMock('../../../src/host/services/infra/sessionTitleCloudPush', () => ({ pushSessionTitleToCloud: push }));
      vi.resetModules();
    }
  });
});
