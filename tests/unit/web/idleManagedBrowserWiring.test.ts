import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/web/webServer.ts', 'utf8');

describe('startWebServer idle managed browser lifecycle wiring', () => {
  it('shutdown closes only idle browsers before the real pending-op drain and keeps the final catch-all', () => {
    const shutdown = source.slice(source.indexOf('const shutdown = async (source'), source.indexOf("process.on('SIGINT', shutdown)"));
    const close = shutdown.indexOf("closeIdleManagedBrowsers('shutdown')");
    expect(close).toBeGreaterThan(-1);
    expect(close).toBeLessThan(shutdown.indexOf('await drainPendingOpsForShutdown('));
    expect(shutdown.indexOf('await runShutdownFinalizers(')).toBeGreaterThan(shutdown.indexOf('await drainPendingOpsForShutdown('));
    expect(readFileSync('src/web/webShutdownFinalizers.ts', 'utf8')).toContain('killManagedChromeProcesses()');
  });

  it('shell EOF resident branch logs the decision then closes idle browsers before returning', () => {
    const callback = source.slice(source.indexOf('const onShellPipeClosed ='), source.indexOf('if (daemonExitRechecker) {'));
    const close = callback.indexOf("closeIdleManagedBrowsers('shell-exit-resident')");
    expect(close).toBeGreaterThan(callback.indexOf('if (!shouldStay) {'));
    expect(close).toBeGreaterThan(callback.indexOf('[daemon] shell exited while busy'));
    expect(callback).toContain('shellPipeAttached = false');
  });

  it('residency transitions close idle browsers only with the shell pipe detached, before rechecking exit', () => {
    const hook = /const onResidencySignal = \(\) => \{([^\n]+)\};/.exec(source)?.[1];
    expect(hook).toBeDefined();
    expect(hook).toContain("if (!shellPipeAttached) closeIdleManagedBrowsers('residency-idle')");
    expect(hook!.indexOf('closeIdleManagedBrowsers(')).toBeLessThan(hook!.indexOf('daemonExitRechecker.recheck()'));
    expect(source).toContain('runRegistry.onIdleTransition(onResidencySignal)');
    expect(source).toContain('onForegroundPermissionStateChange(onResidencySignal)');
    expect(source).toContain("getTaskManager().on('event', onResidencySignal)");
  });
});
