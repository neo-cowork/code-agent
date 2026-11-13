import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BROWSER_TIMEOUTS } from '../../../../shared/constants/timeouts';
import type { BrowserLogger } from './logger';
import { isPathInsideRoot, MANAGED_BROWSER_ISOLATED_PROFILE_PREFIX } from './managedBrowserHelpers';

let started = false;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Unknown errors are conservative too: only ESRCH proves the process is gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Best-effort crash cleanup, restricted to direct isolated-root children. */
export async function sweepStaleIsolatedBrowserProfiles(options: {
  tmpDir?: string;
  now?: number;
  isPidAlive?: (pid: number) => boolean;
  graceMs?: number;
  currentProfileDir?: string | null;
  oncePerProcess?: boolean;
  logger: Pick<BrowserLogger, 'log'>;
}): Promise<void> {
  if (options.oncePerProcess && started) return;
  if (options.oncePerProcess) started = true;
  const { logger } = options;
  const counts = { removed: 0, freedBytes: 0, skippedLive: 0, skippedYoung: 0, skippedOther: 0, failed: 0 };
  const root = path.join(options.tmpDir ?? os.tmpdir(), MANAGED_BROWSER_ISOLATED_PROFILE_PREFIX);
  const now = options.now ?? Date.now();
  const grace = options.graceMs ?? BROWSER_TIMEOUTS.ISOLATED_PROFILE_SWEEP_GRACE;
  const deadline = Date.now() + BROWSER_TIMEOUTS.ISOLATED_PROFILE_SWEEP_WALK_BUDGET;
  let entries = 0;
  const skip = (name: string, reason: string) => {
    counts.skippedOther++;
    logger.log('DEBUG', `Isolated profile sweep kept ${name}: ${reason}`);
  };
  const eligible = async (dir: string): Promise<string | null> => {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'not-directory';
    if (options.currentProfileDir && dir === await fs.realpath(options.currentProfileDir)) return 'current-session';
    let lock;
    try {
      lock = await fs.lstat(path.join(dir, 'SingletonLock'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (now - Math.max(stat.mtimeMs, lock?.mtimeMs ?? stat.mtimeMs) < grace) return 'young';
    if (lock) {
      if (!lock.isSymbolicLink()) return 'unparseable-lock';
      const target = await fs.readlink(path.join(dir, 'SingletonLock'));
      const match = /^(.+)-(\d+)$/.exec(target);
      if (!match) return 'unparseable-lock';
      const [, host, rawPid] = match;
      const pid = Number(rawPid);
      if (!Number.isSafeInteger(pid) || pid <= 0) return 'unparseable-lock';
      if (host !== os.hostname()) return 'foreign-host';
      if ((options.isPidAlive ?? isPidAlive)(pid)) return 'live';
    }
    return null;
  };
  const accountSkip = (name: string, reason: string) => {
    if (reason === 'live') counts.skippedLive++;
    else if (reason === 'young') counts.skippedYoung++;
    else skip(name, reason);
  };
  // lstat never follows file symlinks; opendir is used only on real directories.
  const measure = async (dir: string): Promise<number> => {
    let bytes = 0;
    const pending = [dir];
    while (pending.length) {
      const next = pending.pop();
      if (!next) continue;
      const stat = await fs.lstat(next);
      if (++entries > BROWSER_TIMEOUTS.ISOLATED_PROFILE_SWEEP_MAX_ENTRIES || Date.now() > deadline) {
        throw new Error('size-walk-budget');
      }
      if (stat.isDirectory()) {
        if (!isPathInsideRoot(await fs.realpath(next), canonicalRoot)) throw new Error('path-changed');
        const children = await fs.opendir(next);
        for await (const child of children) {
          if (++entries > BROWSER_TIMEOUTS.ISOLATED_PROFILE_SWEEP_MAX_ENTRIES || Date.now() > deadline) {
            throw new Error('size-walk-budget');
          }
          // A replaced directory must not redirect traversal outside the root.
          const childPath = path.join(next, child.name);
          if (!isPathInsideRoot(await fs.realpath(next), canonicalRoot)) throw new Error('path-changed');
          pending.push(childPath);
        }
      } else if (stat.isFile()) bytes += stat.size;
    }
    return bytes;
  };
  let canonicalRoot = '';
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      skip(MANAGED_BROWSER_ISOLATED_PROFILE_PREFIX, 'unsafe-root');
      return;
    }
    canonicalRoot = await fs.realpath(root);
    const children = await fs.opendir(canonicalRoot);
    for await (const child of children) {
      const dir = path.join(canonicalRoot, child.name);
      try {
        const reason = await eligible(dir);
        if (reason) {
          accountSkip(child.name, reason);
          continue;
        }
        let bytes;
        try {
          bytes = await measure(dir);
        } catch (error) {
          skip(child.name, String(error));
          continue;
        }
        // Recheck locks/age after accounting: another browser may have acquired it.
        const changed = await eligible(dir);
        if (changed) {
          accountSkip(child.name, changed);
          continue;
        }
        const rootNow = await fs.lstat(root);
        if (rootNow.ino !== rootStat.ino || rootNow.dev !== rootStat.dev || rootNow.isSymbolicLink()
          || !isPathInsideRoot(dir, canonicalRoot) || !isPathInsideRoot(await fs.realpath(dir), canonicalRoot)) {
          skip(child.name, 'path-changed');
          continue;
        }
        await fs.rm(dir, { recursive: true, force: true });
        counts.removed++;
        counts.freedBytes += bytes;
      } catch (error) {
        counts.failed++;
        logger.log('WARN', `Isolated profile sweep failed ${child.name}: ${error}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      counts.failed++;
      logger.log('WARN', `Isolated profile sweep failed root: ${error}`);
    }
  } finally {
    logger.log('INFO', `Isolated profile sweep ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  }
}
