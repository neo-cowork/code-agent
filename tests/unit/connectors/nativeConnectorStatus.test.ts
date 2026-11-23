import { describe, expect, it, vi } from 'vitest';

const configState = vi.hoisted(() => ({ language: 'zh' }));
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: configState.language } }) }),
}));

const osascriptMocks = vi.hoisted(() => ({
  runAppleScript: vi.fn(async () => 'Work\nPersonal'),
}));

vi.mock('../../../src/host/connectors/native/osascript', async (importOriginal) => ({
  ...(await (async () => {
    const real = await importOriginal<typeof import('../../../src/host/connectors/native/osascript')>();
    return { describeAppleScriptFailure: real.describeAppleScriptFailure, isAppleScriptFailure: real.isAppleScriptFailure };
  })()),
  runAppleScript: osascriptMocks.runAppleScript,
  escapeAppleScriptString: (value: string) => value,
  parseAppleScriptDate: () => null,
  buildAppleScriptDateVar: () => [],
  sharedAppleScriptHandlers: () => [],
}));

import { mailConnector } from '../../../src/host/connectors/native/mail';
import { photosConnector, resetPhotosConnectorReadiness } from '../../../src/host/connectors/native/photos';
import { remindersConnector } from '../../../src/host/connectors/native/reminders';
import { ConnectorRegistry } from '../../../src/host/connectors/registry';

describe('native office connector lazy status', () => {
  const platformReadiness = process.platform === 'darwin' ? 'unchecked' : 'unavailable';

  it('keeps mail status side-effect free on startup', async () => {
    const status = await mailConnector.getStatus();

    expect(status).toMatchObject({
      connected: false,
      readiness: platformReadiness,
      capabilities: mailConnector.capabilities,
    });
    if (process.platform === 'darwin') {
      expect(status.actions).toEqual(['repair_permissions', 'disconnect', 'remove']);
    }
    expect(status.detailCode).toBe(process.platform === 'darwin' ? 'unchecked' : 'platform_unsupported');
    expect(status.detail).toBeUndefined();
    expect(status.error).toBeUndefined();
    expect(osascriptMocks.runAppleScript).not.toHaveBeenCalled();
  });

  it('keeps reminders status side-effect free on startup', async () => {
    const status = await remindersConnector.getStatus();

    expect(status).toMatchObject({
      connected: false,
      readiness: platformReadiness,
      capabilities: remindersConnector.capabilities,
    });
    if (process.platform === 'darwin') {
      expect(status.actions).toEqual(['repair_permissions', 'disconnect', 'remove']);
    }
    expect(status.detailCode).toBe(process.platform === 'darwin' ? 'unchecked' : 'platform_unsupported');
    expect(status.detail).toBeUndefined();
    expect(status.error).toBeUndefined();
    expect(osascriptMocks.runAppleScript).not.toHaveBeenCalled();
  });

  // 日历状态改读 EventKit 被动探针，见 calendarEventKit.test.ts

  it('runs the real native probe only when explicitly requested', async () => {
    osascriptMocks.runAppleScript.mockClear();

    if (process.platform !== 'darwin') {
      await expect(mailConnector.execute('probe_access', {})).rejects.toThrow('only available on macOS');
      expect(osascriptMocks.runAppleScript).not.toHaveBeenCalled();
      return;
    }

    const result = await mailConnector.execute('probe_access', {});
    const status = result.data as Awaited<ReturnType<typeof mailConnector.getStatus>>;

    expect(osascriptMocks.runAppleScript).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      connected: true,
      readiness: 'ready',
    });
    expect(result.summary).toContain('检查通过');
  });

  it('routes native permission repair through an explicit lifecycle action', async () => {
    osascriptMocks.runAppleScript.mockClear();

    if (process.platform !== 'darwin') {
      await expect(remindersConnector.execute('repair_permissions', {})).rejects.toThrow('only available on macOS');
      expect(osascriptMocks.runAppleScript).not.toHaveBeenCalled();
      return;
    }

    const result = await remindersConnector.execute('repair_permissions', {});
    const status = result.data as Awaited<ReturnType<typeof remindersConnector.getStatus>>;

    expect(osascriptMocks.runAppleScript).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      connected: true,
      readiness: 'ready',
      actions: ['disconnect', 'remove'],
    });
    expect(result.summary).toContain('权限修复检查通过');
  });

  it('resets cached native readiness when the connector is disabled', async () => {
    osascriptMocks.runAppleScript.mockClear();

    if (process.platform !== 'darwin') {
      // 平台过滤注册：非 macOS 上 configure 不注册原生 connector（windows-support.md §1.5）
      const registry = new ConnectorRegistry();
      registry.configure(['mail']);
      expect(registry.get('mail')).toBeUndefined();
      return;
    }

    const registry = new ConnectorRegistry();
    registry.configure(['mail']);

    await mailConnector.execute('probe_access', {});
    expect(await registry.get('mail')?.getStatus()).toMatchObject({
      connected: true,
      readiness: 'ready',
    });

    registry.configure([]);
    registry.configure(['mail']);

    expect(await registry.get('mail')?.getStatus()).toMatchObject({
      connected: false,
      readiness: 'unchecked',
    });
    expect(osascriptMocks.runAppleScript).toHaveBeenCalledTimes(1);
  });

  it('flags ready-but-empty listings on the status itself (repairPermission discards the execute summary)', async () => {
    osascriptMocks.runAppleScript.mockClear();

    if (process.platform !== 'darwin') {
      await expect(remindersConnector.execute('repair_permissions', {})).rejects.toThrow('only available on macOS');
      return;
    }

    // 授权通过但列表为空：osascript 正常返回空输出（不是抛错）
    osascriptMocks.runAppleScript.mockResolvedValue('');
    await remindersConnector.execute('repair_permissions', {});

    // repairPermission 的 IPC 回执是 handleListStatuses() → getStatus()，「没有找到可访问…」
    // 只在被丢弃的 execute summary 里；空列表信号必须挂在状态上，否则渲染层永远看不到
    expect(await remindersConnector.getStatus()).toMatchObject({
      connected: true,
      readiness: 'ready',
      noAccessibleItems: true,
    });

    // 非空列表不许误报
    osascriptMocks.runAppleScript.mockResolvedValue('Work\nPersonal');
    await remindersConnector.execute('repair_permissions', {});
    expect(await remindersConnector.getStatus()).toMatchObject({
      connected: true,
      readiness: 'ready',
      noAccessibleItems: false,
    });
  });

  it.runIf(process.platform === 'darwin')('keeps script text out of the failed status detail (session_1793802444569_5eb4b15b shape)', async () => {
    const script = 'tell application "Calendar"\nset outputLines to {}\nreturn my joinLines(outputLines)\nend tell';
    const raw = Object.assign(
      new Error(`Command failed: osascript -e ${script}\n0:5: execution error: Calendar got an error: Not authorized to send Apple events to Calendar. (-1743)`),
      { code: 1 },
    );
    for (const connector of [mailConnector, remindersConnector]) {
      osascriptMocks.runAppleScript.mockRejectedValueOnce(raw);
      await expect(connector.execute('repair_permissions', {})).rejects.toBe(raw);
      const status = await connector.getStatus();
      expect(status.readiness).toBe('failed');
      expect(status.detailCode).toBe('automation_not_authorized');
      expect(status.detail).toBeUndefined();
      expect(status.error).toBeUndefined();
      expect(JSON.stringify(status)).not.toMatch(/osascript|Command failed|tell application|outputLines/);
    }
  });

  it.runIf(process.platform === 'darwin')('ready status (with and without accounts) carries a code and no prose', async () => {
    for (const connector of [mailConnector, remindersConnector]) {
      for (const output of ['Work\nPersonal', '']) {
        osascriptMocks.runAppleScript.mockResolvedValueOnce(output);
        await connector.execute('probe_access', {});
        const status = await connector.getStatus();
        expect(status).toMatchObject({ readiness: 'ready', detailCode: 'ready', noAccessibleItems: output === '' });
        expect(status.detail).toBeUndefined();
        expect(status.error).toBeUndefined();
        expect(JSON.stringify(status)).not.toMatch(/[\u3400-\u9fff]/);
      }
    }
  });

  it.runIf(process.platform === 'darwin')('maps every failure shape to a stable detailCode with no prose in detail/error', async () => {
    const cases: Array<[unknown, string, string | undefined]> = [
      [Object.assign(new Error('Command failed: osascript\n(-1743)'), { stderr: '(-1743)' }), 'automation_not_authorized', 'not_authorized'],
      [Object.assign(new Error('Command failed: osascript\n(-1728)'), { stderr: "Can't get account (-1728)" }), 'not_found', undefined],
      [Object.assign(new Error('Command failed: osascript'), { killed: true, signal: 'SIGTERM' }), 'timeout', undefined],
      [Object.assign(new Error('Command failed: osascript'), { code: 1, stderr: 'weird' }), 'read_failed', undefined],
      [new Error('some internal failure /Users/someone/x'), 'probe_failed', undefined],
    ];
    for (const connector of [mailConnector, remindersConnector]) {
      for (const [raw, detailCode, errorCode] of cases) {
        osascriptMocks.runAppleScript.mockRejectedValueOnce(raw);
        await expect(connector.execute('probe_access', {})).rejects.toBe(raw);
        const status = await connector.getStatus();
        expect(status).toMatchObject({ readiness: 'failed', detailCode, errorCode });
        expect(status.detail).toBeUndefined();
        expect(status.error).toBeUndefined();
        expect(JSON.stringify(status)).not.toMatch(/[\u3400-\u9fff]|osascript|Command failed|\/Users\//);
      }
    }
  });

  it.runIf(process.platform === 'darwin')('photos reports a code per state with no prose in detail/error', async () => {
    resetPhotosConnectorReadiness();
    expect(await photosConnector.getStatus()).toMatchObject({ readiness: 'unchecked', detailCode: 'unchecked' });

    osascriptMocks.runAppleScript.mockResolvedValueOnce('3');
    await photosConnector.execute('probe_access', {});
    expect(await photosConnector.getStatus()).toMatchObject({ readiness: 'ready', detailCode: 'ready' });

    resetPhotosConnectorReadiness();
    osascriptMocks.runAppleScript.mockRejectedValueOnce(new Error('Not authorized to send Apple events to Photos. (-1743) not authorized'));
    await photosConnector.execute('probe_access', {});
    expect(await photosConnector.getStatus()).toMatchObject({ readiness: 'failed', detailCode: 'photos_failed' });

    resetPhotosConnectorReadiness();
    osascriptMocks.runAppleScript.mockRejectedValueOnce(new Error('Photos got an error: something /Users/someone/Pictures'));
    await photosConnector.execute('probe_access', {});
    const unavailable = await photosConnector.getStatus();
    expect(unavailable).toMatchObject({ readiness: 'unavailable', detailCode: 'photos_unavailable' });
    for (const status of [unavailable]) {
      expect(status.detail).toBeUndefined();
      expect(status.error).toBeUndefined();
      expect(JSON.stringify(status)).not.toMatch(/[\u3400-\u9fff]|\/Users\//);
    }
  });
});
