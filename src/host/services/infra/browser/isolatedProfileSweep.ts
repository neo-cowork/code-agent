import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { BROWSER_TIMEOUTS } from '../../../../shared/constants/timeouts';
import type { BrowserLogger } from './logger';
import { isPathInsideRoot, MANAGED_BROWSER_ISOLATED_PROFILE_PREFIX, MANAGED_BROWSER_ISOLATED_OWNER_FILE } from './managedBrowserHelpers';

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

/** One `ps` call listing every command line; rejects where unsupported or oversized. */
function listProcessCommands(): Promise<string> {
  if (process.platform === 'win32') return Promise.reject(new Error('unsupported-platform'));
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'command'], { maxBuffer: BROWSER_TIMEOUTS.ISOLATED_PROFILE_SWEEP_PROBE_MAX_BYTES, timeout: BROWSER_TIMEOUTS.ISOLATED_PROFILE_SWEEP_PROBE_TIMEOUT }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function commandUsesDir(commands: string, dirs: string[]): boolean {
  const marker = '--user-data-dir=';
  for (const line of commands.split('\n')) {
    let from = line.indexOf(marker);
    while (from !== -1) {
      let rest = line.slice(from + marker.length);
      if (rest.startsWith('"') || rest.startsWith("'")) rest = rest.slice(1);
      for (const dir of dirs) {
        if (!rest.startsWith(dir)) continue;
        const next = rest.charAt(dir.length);
        // A sibling that merely extends the name (`-abc` vs `-abc-2`) must not match.
        if (next === '' || /[\s"'/]/.test(next)) return true;
      }
      from = line.indexOf(marker, from + marker.length);
    }
  }
  return false;
}

/** Best-effort crash cleanup, restricted to direct isolated-root children. */
export async function sweepStaleIsolatedBrowserProfiles(options: {
  tmpDir?: string;
  now?: number;
  isPidAlive?: (pid: number) => boolean;
  /** Returns all process command lines (default: `ps -axo command`). */
  listProcessCommands?: () => Promise<string>;
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
  const lockBlocks = async (lock: import('fs').Stats | undefined, dir: string): Promise<string | null> => {
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
  let snapshot: Promise<string> | null = null;
  // One ps per sweep; the post-measure recheck passes fresh=true so a browser started meanwhile is seen.
  const probe = (fresh: boolean) => (fresh || !snapshot ? (snapshot = (options.listProcessCommands ?? listProcessCommands)()) : snapshot);
  const eligible = async (dir: string, fresh = false): Promise<string | null> => {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'not-directory';
    if (options.currentProfileDir && dir === await fs.realpath(options.currentProfileDir)) return 'current-session';
    let lock;
    try {
      lock = await fs.lstat(path.join(dir, 'SingletonLock'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const ownerPath = path.join(dir, MANAGED_BROWSER_ISOLATED_OWNER_FILE);
    let ownerStat;
    try {
      ownerStat = await fs.lstat(ownerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const age = now - Math.max(stat.mtimeMs, lock?.mtimeMs ?? stat.mtimeMs, ownerStat?.mtimeMs ?? stat.mtimeMs);
    // Absence of Chrome's SingletonLock never proves inactivity: headless shell and
    // Windows do not create it. Pre-marker profiles need a long grace plus a process probe.
    if (!ownerStat) {
      if (age < BROWSER_TIMEOUTS.ISOLATED_PROFILE_SWEEP_LEGACY_GRACE) return 'young-legacy';
      let commands: string;
      try {
        commands = await probe(fresh);
      } catch {
        return 'legacy-probe-unavailable';
      }
      // Chrome is launched with the os.tmpdir()-based path, which differs from the canonical one on macOS (/var vs /private/var).
      if (commandUsesDir(commands, [dir, path.join(root, path.basename(dir))])) return 'live';
      return lockBlocks(lock, dir);
    }
    if (age < grace) return 'young';
    if (!ownerStat.isFile() || ownerStat.size > BROWSER_TIMEOUTS.ISOLATED_PROFILE_SWEEP_OWNER_MAX_BYTES) return 'unparseable-owner';
    let owner: unknown;
    try {
      owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    } catch {
      return 'unparseable-owner';
    }
    if (!owner || typeof owner !== 'object' || !('host' in owner) || !('pid' in owner) || !('processStartedAt' in owner)
      || typeof owner.host !== 'string' || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.processStartedAt !== 'number' || !Number.isFinite(owner.processStartedAt)
      || owner.processStartedAt <= 0 || owner.processStartedAt > now) return 'unparseable-owner';
    if (owner.host !== os.hostname()) return 'foreign-owner';
    // PID reuse is deliberately conservative: a live PID is kept regardless of start time.
    if ((options.isPidAlive ?? isPidAlive)(owner.pid)) return 'live';
    return lockBlocks(lock, dir);
  };
  const accountSkip = (name: string, reason: string) => {
    if (reason === 'live') {
      counts.skippedLive++;
      logger.log('DEBUG', `Isolated profile sweep kept ${name}: live`);
    }
    else if (reason === 'young' || reason === 'young-legacy') counts.skippedYoung++;
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
        const changed = await eligible(dir, true);
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
