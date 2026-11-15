import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync as readFile, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createShutdownStepCap,
  runShutdownFinalizers,
} from '../../../src/web/webShutdownFinalizers';
import { WEB_SERVER_SHUTDOWN_TIMEOUTS } from '../../../src/shared/constants/timeouts';

const disconnectAll = vi.fn(async () => {});
const getStdioChildPids = vi.fn((): number[] => []);
const shutdownPostHog = vi.fn(async () => {});
const langfuseCleanupAll = vi.fn(async () => {});
const langfuseShutdown = vi.fn(async () => {});
const cleanupSessionStateManager = vi.fn(() => {});
const disposeAgentRegistry = vi.fn(async () => {});
const stopPtyCleanupTimer = vi.fn(() => {});
const stopBackgroundTaskCleanupTimer = vi.fn(() => {});
const stopConnectorStatusWatcher = vi.fn(() => {});
const stopRateLimitCleanupTimer = vi.fn(() => {});

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({ disconnectAll, getStdioChildPids }),
}));
vi.mock('../../../src/host/observability/posthogNode', () => ({
  shutdownPostHog: () => shutdownPostHog(),
}));
vi.mock('../../../src/host/services/infra/langfuseService', () => ({
  getLangfuseService: () => ({
    cleanupAll: () => langfuseCleanupAll(),
    shutdown: () => langfuseShutdown(),
  }),
}));
vi.mock('../../../src/host/session/sessionStateManager', () => ({
  cleanupSessionStateManager: () => cleanupSessionStateManager(),
}));
vi.mock('../../../src/host/agent/agentRegistry', () => ({
  disposeAgentRegistry: () => disposeAgentRegistry(),
}));
vi.mock('../../../src/host/tools/shell/ptyExecutor', () => ({
  stopPtyCleanupTimer: () => stopPtyCleanupTimer(),
}));
vi.mock('../../../src/host/tools/shell/backgroundTasks', () => ({
  stopBackgroundTaskCleanupTimer: () => stopBackgroundTaskCleanupTimer(),
}));
vi.mock('../../../src/host/ipc/connector.ipc', () => ({
  stopConnectorStatusWatcher: () => stopConnectorStatusWatcher(),
}));
vi.mock('../../../src/web/middleware/auth', () => ({
  stopRateLimitCleanupTimer: () => stopRateLimitCleanupTimer(),
}));

const ALL_LABELS = [
  'mcp.disconnect',
  'posthog.flush',
  'langfuse.flush',
  'sessionState.cleanup',
  'agentRegistry.dispose',
  'cleanupTimers.stop',
];

beforeEach(() => {
  vi.clearAllMocks();
  // 默认让 cua reaper 指向一个不存在的 helper 路径，绝不碰本机真实的 Agent Neo Computer Use 进程
  process.env.CODE_AGENT_CUA_DRIVER_PATH = '/nonexistent/Fake Helper Default.app/Contents/MacOS/cua-driver';
  disconnectAll.mockImplementation(async () => {});
  getStdioChildPids.mockImplementation(() => []);
  shutdownPostHog.mockImplementation(async () => {});
  langfuseCleanupAll.mockImplementation(async () => {});
  langfuseShutdown.mockImplementation(async () => {});
  disposeAgentRegistry.mockImplementation(async () => {});
});

describe('runShutdownFinalizers — 死文件 lifecycle.ts 记的责任，接进真属主', () => {
  it('正例：六步全跑到，且每步都在日志里留痕', async () => {
    const lines: string[] = [];
    await runShutdownFinalizers(1_000, (msg) => lines.push(msg));

    expect(disconnectAll).toHaveBeenCalledTimes(1);
    expect(shutdownPostHog).toHaveBeenCalledTimes(1);
    expect(langfuseCleanupAll).toHaveBeenCalledTimes(1);
    expect(langfuseShutdown).toHaveBeenCalledTimes(1);
    expect(cleanupSessionStateManager).toHaveBeenCalledTimes(1);
    expect(disposeAgentRegistry).toHaveBeenCalledTimes(1);

    expect(lines.filter((l) => !l.includes('cua.reap'))).toHaveLength(1);
    for (const label of ALL_LABELS) {
      expect(lines[0]).toContain(`${label}=ok(`);
    }
  });

  it('N-SHUTDOWN-DEADLINK：原挂死表的四处定时器清理，活停机会跑到（各恰一次）', async () => {
    await runShutdownFinalizers(1_000, () => {});

    expect(stopPtyCleanupTimer).toHaveBeenCalledTimes(1);
    expect(stopBackgroundTaskCleanupTimer).toHaveBeenCalledTimes(1);
    expect(stopConnectorStatusWatcher).toHaveBeenCalledTimes(1);
    expect(stopRateLimitCleanupTimer).toHaveBeenCalledTimes(1);
  });

  it('负例（故障注入）：一步抛错不影响其余五步，且日志指名道姓', async () => {
    shutdownPostHog.mockRejectedValueOnce(new Error('posthog boom'));
    const lines: string[] = [];

    await expect(runShutdownFinalizers(1_000, (msg) => lines.push(msg))).resolves.toBeUndefined();

    expect(lines[0]).toContain('posthog.flush=failed(posthog boom)');
    for (const label of ALL_LABELS.filter((l) => l !== 'posthog.flush')) {
      expect(lines[0]).toContain(`${label}=ok(`);
    }
    // 其余五步真的跑了，不是被短路掉
    expect(disconnectAll).toHaveBeenCalledTimes(1);
    expect(disposeAgentRegistry).toHaveBeenCalledTimes(1);
    expect(stopRateLimitCleanupTimer).toHaveBeenCalledTimes(1);
  });

  it('负例（挂死）：断连挂住时到上限跳过，并对幸存的 MCP 子进程补 SIGKILL', async () => {
    // 真进程：MCP server 无视 stdin 关闭时，SDK 的优雅阶梯（2s+2s）根本走不完宽限期，
    // 所以属主必须自己补刀。这里用一个真 sleep 进程验它确实被杀掉。
    const survivor = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => {
      survivor.on('exit', (_code, signal) => resolve(signal === 'SIGKILL' ? 1 : 0));
    });

    getStdioChildPids.mockImplementation(() => [survivor.pid as number]);
    disconnectAll.mockImplementation(() => new Promise<void>(() => {})); // 永不 resolve

    const lines: string[] = [];
    await runShutdownFinalizers(50, (msg) => lines.push(msg));

    expect(lines[0]).toContain('mcp.disconnect=timeout(');
    expect(lines[0]).toContain('mcp.killed=1/1');
    expect(await exited).toBe(1);
    // 挂死的那一步没有拖垮其它步骤
    expect(lines[0]).toContain('posthog.flush=ok(');
  });

  it('MCP 从没初始化过时不炸：无子进程、killed=0', async () => {
    const lines: string[] = [];
    await runShutdownFinalizers(1_000, (msg) => lines.push(msg));
    expect(lines[0]).toContain('mcp.killed=0/0');
  });
});

describe('createShutdownStepCap — 关库前总预算', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('每步上限收成 min(STEP_MS, 总预算剩余)，预算烧光后归零', () => {
    let clock = 0;
    const { stepMs } = createShutdownStepCap(2_000, () => clock);

    expect(stepMs()).toBe(WEB_SERVER_SHUTDOWN_TIMEOUTS.STEP_MS);
    clock = 1_500; // 已用掉 1.5s，只剩 500ms 预算
    expect(stepMs()).toBe(500);
    clock = 5_000; // 预算烧穿，绝不再向关库借时间
    expect(stepMs()).toBe(0);
  });

  it('步骤跑赢上限时不得打印「超时」——那行日志会把事后排查引到反方向', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { withCap } = createShutdownStepCap(2_000);

    await withCap(Promise.resolve('done'), 'fastStep');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(warn).not.toHaveBeenCalled();
  });

  it('步骤挂死时到上限放行并留痕', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { withCap } = createShutdownStepCap(20);

    await withCap(new Promise<void>(() => {}), 'hungStep');

    expect(warn).toHaveBeenCalledWith('[shutdown] hungStep timed out, skipping');
  });

  it('companion 停机挂死（keytar 弹框）时后续步骤照跑，关库轮得到', async () => {
    // lan.stop() 会 await 还在飞的 restore()，而 restore() 可能正卡在
    // keytar.getPassword 上等用户点钥匙串授权框——那是一个没有上限的等待。
    // 它一旦不被 withCap 封顶，下面两步一步都轮不到，Rust 侧到点就 SIGKILL。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { withCap } = createShutdownStepCap(60);
    const ran: string[] = [];

    await withCap(new Promise<void>(() => {}), 'companion.stop');
    await withCap((async () => { ran.push('reapChildProcesses'); })(), 'reapChildProcesses');
    ran.push('closeAllDatabaseConnections');

    expect(warn).toHaveBeenCalledWith('[shutdown] companion.stop timed out, skipping');
    expect(ran).toEqual(['reapChildProcesses', 'closeAllDatabaseConnections']);
  });
});

describe('接线守护：收尾步骤必须排在干净关库之前', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/web/webServer.ts'),
    'utf-8',
  );

  it('webServer.shutdown 调了 runShutdownFinalizers，且排在 closeAllDatabaseConnections 之前', () => {
    const finalizers = source.indexOf('runShutdownFinalizers(');
    const closeDb = source.indexOf('closeAllDatabaseConnections()');

    expect(finalizers).toBeGreaterThan(-1);
    expect(closeDb).toBeGreaterThan(-1);
    expect(finalizers).toBeLessThan(closeDb);
  });

  it('预算在 shutdown 内创建（不是模块加载时），否则预算从进程启动就开始烧', () => {
    // shutdown 现在带 source 参数（N-WEBSERVER-DEATH-SUPERVISE-DIAG 退出归因），
    // 锚点跟随签名：仍钉「cap 在 shutdown 函数体内创建」这一语义。
    const shutdownStart = source.indexOf('const shutdown = async (source');
    const capCreated = source.indexOf('createShutdownStepCap()');

    expect(shutdownStart).toBeGreaterThan(-1);
    expect(capCreated).toBeGreaterThan(shutdownStart);
  });

  it('companion 停机排在预算创建之后并经 withCap 封顶——它是唯一会弹系统授权框的 pre-close 步骤', () => {
    const capCreated = source.indexOf('createShutdownStepCap()');
    const companion = source.indexOf('stopCompanion?.()');
    const closeDb = source.indexOf('closeAllDatabaseConnections()');

    expect(companion).toBeGreaterThan(-1);
    // 排在 cap 之前 = 预算时钟根本没起跑，之后每一步的封顶都是空头支票
    expect(companion).toBeGreaterThan(capCreated);
    expect(companion).toBeLessThan(closeDb);
    // 光排在后面不够，必须真被封顶：裸 await 一个可能永不 resolve 的 promise 等于没预算
    expect(source).toMatch(/withCap\(\s*\n\s*stopCompanion\?\.\(\)[\s\S]{0,240}?'companion\.stop'/);
  });

  it('死文件 src/host/app/lifecycle.ts 已删，责任不再有第二个账本', () => {
    expect(() =>
      readFileSync(join(process.cwd(), 'src/host/app/lifecycle.ts'), 'utf-8'),
    ).toThrow();
  });

  it('N-SHUTDOWN-DEADLINK：四处清理不再挂从没跑过的 onShutdown 死表', () => {
    // 那张表的 setupDefaultSignalHandlers 零调用方，挂上去等于换个地方继续死
    // （terminalSessionManager 同款守护）。清理必须走 webShutdownFinalizers 活停机序列。
    for (const file of [
      'src/host/tools/shell/ptyExecutor.ts',
      'src/host/tools/shell/backgroundTasks.ts',
      'src/host/ipc/connector.ipc.ts',
      'src/web/middleware/auth.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf-8');
      expect(source, `${file} 又挂回了 onShutdown 死表`).not.toContain('onShutdown(');
    }
  });

  it('N-SHUTDOWN-DEADLINK：死注册表 gracefulShutdown.ts 整文件已删（含 setupDefaultSignalHandlers）', () => {
    // 信号注册面的完整守护在 shutdownSignalOwnership.static.test.ts（带白名单）；
    // 这里锚文件级删除——onShutdown 表的 setupDefaultSignalHandlers 零调用方，
    // 四处注册迁活停机后整文件死透（同 lifecycle.ts 先例：责任不再有第二个账本）。
    expect(() =>
      readFileSync(join(process.cwd(), 'src/host/services/infra/gracefulShutdown.ts'), 'utf-8'),
    ).toThrow();
  });

  it('browser.kill：停机步骤 SIGTERM 已登记的托管 Chrome，不碰无关进程', async () => {
    const { startChromeParentWatchdog } = await import('../../../src/host/services/infra/browser/browserProcessWatchdog');
    const chrome = spawn('sleep', ['300'], { stdio: 'ignore' });
    const bystander = spawn('sleep', ['300'], { stdio: 'ignore' });
    try {
      startChromeParentWatchdog(chrome, { log: () => {} });
      const exited = new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      const lines: string[] = [];
      await runShutdownFinalizers(1000, (m) => lines.push(m));
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      expect(chrome.signalCode).toBe('SIGTERM');
      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
      expect(lines.join('\n')).toMatch(/browser\.kill=ok\(\d+ms\)/);
    } finally {
      chrome.kill('SIGKILL');
      bystander.kill('SIGKILL');
    }
  });
});

// ----------------------------------------------------------------------------
// cua helper daemon reap —— 真实脱管的假进程（PPID 1），经生产入口 runShutdownFinalizers
// ----------------------------------------------------------------------------
// reaper 只在 darwin 工作（非 darwin 不打日志）；真进程用例只能在 macOS 跑，Linux CI 跳过
describe.runIf(process.platform === 'darwin')('cua helper daemon reap', () => {
  let dir: string;
  let fake: string;
  let sock: string;

  const psRows = () =>
    execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command=']).toString().split('\n');
  const findPid = (needle: string): number | null => {
    const row = psRows().find((r) => r.includes(needle));
    return row ? Number(row.trim().split(/\s+/)[0]) : null;
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const launchDetached = async (sub: 'serve' | 'mcp'): Promise<number> => {
    const needle = `${fake} ${sub} --socket ${sock}`;
    spawn(
      'sh',
      ['-c', 'nohup "$0" "$@" >/dev/null 2>&1 &', fake, sub, '--socket', sock, '--host-bundle-id', 'com.example.fake'],
      { stdio: 'ignore' },
    ).unref();
    for (let i = 0; i < 100; i++) {
      const pid = findPid(needle);
      if (pid) return pid;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`fake ${sub} did not start`);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cua-reap-'));
    const macos = join(dir, 'Fake Helper.app', 'Contents', 'MacOS');
    mkdirSync(macos, { recursive: true });
    fake = join(macos, 'cua-driver');
    sock = join(dir, 'x.sock');
    writeFileSync(
      fake,
      '#!/bin/sh\n' +
        'if [ "$1" = serve ] && [ "$6" != --cua-internal-gate-engaged ]; then\n' +
        '  "$0" serve --socket "$3" --host-bundle-id com.example.fake --cua-internal-gate-engaged &\n' +
        '  echo $! > "$(dirname "$0")/child.$1.pid"\n' +
        'else\n  sleep 60 &\nfi\nwait\n',
    );
    chmodSync(fake, 0o755);
    process.env.CODE_AGENT_CUA_DRIVER_PATH = fake;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const r of psRows()) {
      if (r.includes(dir)) {
        try { process.kill(Number(r.trim().split(/\s+/)[0]), 'SIGKILL'); } catch { /* gone */ }
      }
    }
    for (const sub of ['serve', 'mcp']) {
      try { process.kill(Number(readFile(join(dir, 'Fake Helper.app/Contents/MacOS', `child.${sub}.pid`), 'utf-8')), 'SIGKILL'); } catch { /* none */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('① 停机后 PPID=1 的假 serve 守护进程（含其子进程）被收掉，日志留痕', async () => {
    const pid = await launchDetached('serve');
    const row = psRows().find((r) => r.trim().startsWith(`${pid} `))!;
    console.log('BEFORE', row.trim().slice(0, 60), '...');
    expect(row.trim().split(/\s+/)[1]).toBe('1');
    await new Promise((r) => setTimeout(r, 150));
    const child = Number(readFile(join(dir, 'Fake Helper.app/Contents/MacOS/child.serve.pid'), 'utf-8'));
    expect(alive(child)).toBe(true);

    const lines: string[] = [];
    await runShutdownFinalizers(1_000, (m) => lines.push(m));

    const line = lines.find((l) => l.includes('cua.reap'))!;
    console.log('LINE', line);
    expect(line).toContain('cua.reap daemons=1 killed=1 kept=0 failed=0');
    expect(alive(pid)).toBe(false);
    expect(alive(child)).toBe(false);
    console.log('AFTER ps -p', pid, psRows().filter((r) => r.trim().startsWith(`${pid} `)).length, 'rows');
  });

  it('② 另有 <fake> mcp --socket 同 socket 的代理活着 ⇒ 守护进程保留，日志 shared_by_1_proxy', async () => {
    const daemon = await launchDetached('serve');
    const proxy = await launchDetached('mcp');

    const lines: string[] = [];
    await runShutdownFinalizers(1_000, (m) => lines.push(m));

    const line = lines.find((l) => l.includes('cua.reap'))!;
    console.log('LINE', line);
    expect(line).toContain('cua.reap daemons=1 killed=0 kept=1 failed=0');
    expect(line).toContain('shared_by_1_proxy');
    expect(alive(daemon)).toBe(true);
    expect(alive(proxy)).toBe(true);
  });

  it('②b 另一槽的 helper 副本（不同路径、同 socket）的代理活着 ⇒ 守护进程保留', async () => {
    const daemon = await launchDetached('serve');
    const macos2 = join(dir, 'Fake Helper 2.app', 'Contents', 'MacOS');
    mkdirSync(macos2, { recursive: true });
    const fake2 = join(macos2, 'cua-driver');
    writeFileSync(fake2, '#!/bin/sh\nsleep 60 &\nwait\n');
    chmodSync(fake2, 0o755);
    spawn('sh', ['-c', 'nohup "$0" "$@" >/dev/null 2>&1 &', fake2, 'mcp', '--socket', sock], { stdio: 'ignore' }).unref();
    let proxy: number | null = null;
    for (let i = 0; i < 100 && !proxy; i++) {
      proxy = findPid(`${fake2} mcp --socket ${sock}`);
      if (!proxy) await new Promise((r) => setTimeout(r, 30));
    }
    expect(proxy).not.toBeNull();

    const lines: string[] = [];
    await runShutdownFinalizers(1_000, (m) => lines.push(m));

    const line = lines.find((l) => l.includes('cua.reap'))!;
    console.log('LINE', line);
    expect(line).toContain('cua.reap daemons=1 killed=0 kept=1 failed=0');
    expect(line).toContain('shared_by_1_proxy');
    expect(alive(daemon)).toBe(true);
  });

  it('③ kill 失败（EPERM）⇒ failed=1 且原因入日志，进程仍在', async () => {
    const daemon = await launchDetached('serve');
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 'SIGTERM' && pid === daemon) {
        throw Object.assign(new Error('nope'), { code: 'EPERM' });
      }
      return realKill(pid, sig as NodeJS.Signals);
    }) as typeof process.kill);

    const lines: string[] = [];
    await runShutdownFinalizers(1_000, (m) => lines.push(m));

    const line = lines.find((l) => l.includes('cua.reap'))!;
    console.log('LINE', line);
    expect(line).toContain('cua.reap daemons=1 killed=0 kept=0 failed=1');
    expect(line).toContain('failed(EPERM)');
  });

  it('路径回退成裸 cua-driver ⇒ 什么都不碰，留痕 helper_path_unresolved', async () => {
    process.env.CODE_AGENT_CUA_DRIVER_PATH = 'cua-driver';
    const daemon = await launchDetached('serve');
    const lines: string[] = [];
    await runShutdownFinalizers(1_000, (m) => lines.push(m));
    expect(lines.find((l) => l.includes('cua.reap'))).toContain('helper_path_unresolved');
    expect(alive(daemon)).toBe(true);
  });
});

describe('cua reap 受关库前总预算约束', () => {
  afterEach(() => {
    vi.doUnmock('../../../src/host/mcp/cuaHelperReaper');
    vi.resetModules();
  });

  it('reaper 挂死时到 capMs 剩余额度放行并留痕，不拖过总预算', async () => {
    vi.resetModules();
    vi.doMock('../../../src/host/mcp/cuaHelperReaper', () => ({
      reapCuaHelperDaemons: () => new Promise<void>(() => {}),
    }));
    const { runShutdownFinalizers: run } = await import('../../../src/web/webShutdownFinalizers');
    const lines: string[] = [];
    const t0 = Date.now();
    await run(300, (m) => lines.push(m));
    const elapsed = Date.now() - t0;
    expect(lines.join('\n')).toMatch(/cua\.reap timeout\(\d+ms\)/);
    expect(elapsed).toBeLessThan(450);
  });

  it('预算已被前面步骤烧光时直接跳过并留痕', async () => {
    vi.resetModules();
    const reap = vi.fn(async () => {});
    vi.doMock('../../../src/host/mcp/cuaHelperReaper', () => ({ reapCuaHelperDaemons: reap }));
    const { runShutdownFinalizers: run } = await import('../../../src/web/webShutdownFinalizers');
    let clock = 0;
    const lines: string[] = [];
    disconnectAll.mockImplementation(async () => { clock += 500; });
    await run(300, (m) => lines.push(m), () => clock);
    expect(lines.join('\n')).toContain('cua.reap skipped(budget_exhausted)');
    expect(reap).not.toHaveBeenCalled();
  });
});

describe('cua helper daemon reap — 启动入口（注入 ps / 时钟）', () => {
  const D = '/x/Fake Helper.app/Contents/MacOS/cua-driver';
  const run = async (psOut: string) => {
    const { reapCuaHelperDaemons } = await import('../../../src/host/mcp/cuaHelperReaper');
    const kill = vi.fn();
    const lines: string[] = [];
    await reapCuaHelperDaemons({
      phase: 'startup',
      log: (m) => lines.push(m),
      deps: { platform: 'darwin', resolveDriverPath: async () => D, ps: async () => psOut, kill, sleep: async () => {} },
    });
    return { kill, line: lines.join('\n') };
  };

  it('④ 超过 60s 且零代理 ⇒ 收（含子进程树）', async () => {
    const { kill, line } = await run(
      `100 1 02:00:00 ${D} serve --socket /s.sock --host-bundle-id a\n101 100 02:00:00 ${D} serve --socket /s.sock --cua-internal-gate-x\n`,
    );
    expect(line).toContain('cua.reap daemons=1 killed=1');
    expect(kill).toHaveBeenCalledWith(100, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(101, 'SIGTERM');
  });

  it('④ 年轻于 60s ⇒ 保留 younger_than_60s', async () => {
    const { kill, line } = await run(`100 1 00:59 ${D} serve --socket /s.sock\n`);
    expect(line).toContain('kept=1');
    expect(line).toContain('younger_than_60s');
    expect(kill).not.toHaveBeenCalled();
  });

  it('④ 有活代理 ⇒ 保留 shared_by_1_proxy', async () => {
    const { kill, line } = await run(
      `100 1 1-02:00:00 ${D} serve --socket /s.sock\n200 50 05:00 ${D} mcp --socket /s.sock\n`,
    );
    expect(line).toContain('shared_by_1_proxy');
    expect(kill).not.toHaveBeenCalled();
  });

  it('非 darwin ⇒ 无操作', async () => {
    const { reapCuaHelperDaemons } = await import('../../../src/host/mcp/cuaHelperReaper');
    const lines: string[] = [];
    await reapCuaHelperDaemons({ phase: 'startup', log: (m) => lines.push(m), deps: { platform: 'linux' } });
    expect(lines).toEqual([]);
  });
});
