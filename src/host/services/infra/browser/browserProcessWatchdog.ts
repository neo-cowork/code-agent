// 托管 Chrome 随 Neo 服务进程一起死：
//  ① 停机步骤（killManagedChromeProcesses）：正常退出 / SIGTERM 时快速 SIGTERM 记录在案的 pid
//  ② 看门狗（startChromeParentWatchdog）：detached 的 POSIX sh，服务进程被 SIGKILL 时兜底
// 只按精确 pid（及其直接子进程）动手，绝不按进程名杀。
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { BROWSER_TIMEOUTS } from '../../../../shared/constants/timeouts';

type WatchdogLogger = {
  log(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string): void;
};

const WATCHDOG_SCRIPT = [
  'server=$1; chrome=$2; poll=$3; grace=$4',
  'while kill -0 "$server" 2>/dev/null && kill -0 "$chrome" 2>/dev/null; do sleep "$poll"; done',
  'kill -0 "$chrome" 2>/dev/null || exit 0',
  'kids=$(pgrep -P "$chrome" 2>/dev/null)',
  'kill -TERM $kids "$chrome" 2>/dev/null',
  'sleep "$grace"',
  'kill -KILL $kids "$chrome" 2>/dev/null',
  'exit 0',
].join('\n');

/** 当前活着的托管 Chrome 主进程；退出时自动移除。 */
const liveChromeProcesses = new Set<ChildProcess>();

export function startChromeParentWatchdog(chromeProcess: ChildProcess, logger: WatchdogLogger): void {
  const chromePid = chromeProcess.pid;
  if (!chromePid) {
    logger.log('WARN', 'Chrome parent watchdog not started: Chrome has no pid');
    return;
  }
  liveChromeProcesses.add(chromeProcess);
  chromeProcess.once('exit', () => liveChromeProcesses.delete(chromeProcess));

  if (process.platform === 'win32') {
    logger.log('DEBUG', 'Chrome parent watchdog skipped: no sh on Windows');
    return;
  }
  try {
    const watchdog = spawn(
      'sh',
      [
        '-c', WATCHDOG_SCRIPT, 'sh',
        String(process.pid), String(chromePid),
        String(BROWSER_TIMEOUTS.PARENT_WATCHDOG_POLL_SEC),
        String(BROWSER_TIMEOUTS.PARENT_WATCHDOG_KILL_GRACE_SEC),
      ],
      { detached: true, stdio: 'ignore' },
    );
    watchdog.once('error', (error) => {
      logger.log('WARN', `Chrome parent watchdog failed to start: ${error.message}`);
    });
    watchdog.unref();
    logger.log('INFO', `Chrome parent watchdog started serverPid=${process.pid} chromePid=${chromePid}`);
  } catch (error) {
    logger.log('WARN', `Chrome parent watchdog failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function childPids(pid: number): number[] {
  if (process.platform === 'win32') return [];
  try {
    const out = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 500 });
    return String(out.stdout || '').split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** 停机时同步、快速地 SIGTERM 每个活着的托管 Chrome 及其直接子进程；返回处理的主进程数。 */
export function killManagedChromeProcesses(processes: Iterable<ChildProcess> = liveChromeProcesses): number {
  let count = 0;
  for (const chromeProcess of processes) {
    const pid = chromeProcess.pid;
    if (!pid || chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) continue;
    for (const target of [...childPids(pid), pid]) {
      try {
        process.kill(target, 'SIGTERM');
      } catch {
        // 刚好已退出
      }
    }
    count += 1;
  }
  return count;
}
