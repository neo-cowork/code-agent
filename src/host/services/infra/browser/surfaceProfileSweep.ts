import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BROWSER_TIMEOUTS } from '../../../../shared/constants/timeouts';
import type { BrowserLogger } from './logger';
import { commandUsesDir, isPidAlive, listProcessCommands } from './isolatedProfileSweep';
import { isPathInsideRoot, MANAGED_BROWSER_PERSISTENT_PROFILE_ID } from './managedBrowserHelpers';

const SURFACE_PROFILE_PREFIX = `${MANAGED_BROWSER_PERSISTENT_PROFILE_ID}-surface-`;
// Any of these means the dir may hold a signed-in session: never reclaimed.
const LOGIN_FILES = [
  ['Default', 'Cookies'],
  ['Default', 'Network', 'Cookies'],
  ['Default', 'Login Data'],
  ['Cookies'],
  ['Login Data'],
];

let started = false;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function hasLogin(dir: string): Promise<boolean> {
  for (const parts of LOGIN_FILES) {
    if (await exists(path.join(dir, ...parts))) return true;
  }
  return false;
}

async function mtimeOf(target: string): Promise<number> {
  try {
    return (await fs.lstat(target)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function dirBytes(dir: string): Promise<number> {
  let bytes = 0;
  const pending = [dir];
  while (pending.length) {
    const next = pending.pop() as string;
    for (const child of await fs.readdir(next, { withFileTypes: true })) {
      const childPath = path.join(next, child.name);
      if (child.isDirectory()) pending.push(childPath);
      else if (child.isFile()) bytes += (await fs.lstat(childPath)).size;
    }
  }
  return bytes;
}

/**
 * Reclaim leftover `managed-browser-profile-surface-*` dirs directly under userDataDir.
 * Never touches the unsuffixed personal profile; never removes a dir with login files
 * or a live Chrome. `endedProfileDir` limits the pass to that one dir, ignoring age
 * (surface-end trigger); otherwise only dirs idle for the retention window qualify.
 */
export async function sweepSurfaceBrowserProfiles(options: {
  userDataDir: string;
  logger: Pick<BrowserLogger, 'log'>;
  endedProfileDir?: string;
  now?: number;
  retentionMs?: number;
  isPidAlive?: (pid: number) => boolean;
  listProcessCommands?: () => Promise<string>;
  oncePerProcess?: boolean;
}): Promise<void> {
  if (options.oncePerProcess && started) return;
  if (options.oncePerProcess) started = true;
  const { logger } = options;
  const counts = { removed: 0, freedBytes: 0, skippedLive: 0, skippedYoung: 0, skippedKeepsLogin: 0, skippedNotInRoot: 0, skippedOther: 0, failed: 0 };
  const now = options.now ?? Date.now();
  const retention = options.retentionMs ?? BROWSER_TIMEOUTS.SURFACE_PROFILE_SWEEP_RETENTION;
  const keep = (name: string, reason: string, counter: 'skippedLive' | 'skippedYoung' | 'skippedKeepsLogin' | 'skippedNotInRoot' | 'skippedOther') => {
    counts[counter]++;
    logger.log('DEBUG', `Surface profile sweep kept ${name}: ${reason}`);
  };
  const liveReason = async (dir: string, names: string[]): Promise<string | null> => {
    try {
      const target = await fs.readlink(path.join(dir, 'SingletonLock'));
      const match = /^(.+)-(\d+)$/.exec(target);
      if (!match) return 'unparseable-lock';
      const pid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || pid <= 0) return 'unparseable-lock';
      if (match[1] !== os.hostname()) return 'foreign-host';
      if ((options.isPidAlive ?? isPidAlive)(pid)) return 'live';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT: no lock. EINVAL: lock exists but is not a symlink (Windows/odd) - treat as unparseable.
      if (code === 'EINVAL') return 'unparseable-lock';
      if (code !== 'ENOENT') throw error;
    }
    let commands: string;
    try {
      commands = await (options.listProcessCommands ?? listProcessCommands)();
    } catch {
      return 'probe-unavailable';
    }
    return commandUsesDir(commands, names) ? 'live' : null;
  };
  try {
    const rootStat = await fs.lstat(options.userDataDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      keep(options.userDataDir, 'unsafe-root', 'skippedNotInRoot');
      return;
    }
    const root = await fs.realpath(options.userDataDir);
    const names = options.endedProfileDir
      ? [path.basename(options.endedProfileDir)]
      : (await fs.readdir(root)).filter((name) => name.startsWith(SURFACE_PROFILE_PREFIX));
    for (const name of names) {
      if (!name.startsWith(SURFACE_PROFILE_PREFIX) || name.includes(path.sep)
        || (options.endedProfileDir && path.dirname(path.resolve(options.endedProfileDir)) !== path.resolve(options.userDataDir))) {
        keep(name, 'not-in-root', 'skippedNotInRoot');
        continue;
      }
      const dir = path.join(root, name);
      try {
        const stat = await fs.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !isPathInsideRoot(await fs.realpath(dir), root)) {
          keep(name, 'not-in-root', 'skippedNotInRoot');
          continue;
        }
        if (await hasLogin(dir)) {
          keep(name, 'keeps-login', 'skippedKeepsLogin');
          continue;
        }
        if (!options.endedProfileDir) {
          const lastUsed = Math.max(stat.mtimeMs, await mtimeOf(path.join(dir, 'SingletonLock')), await mtimeOf(path.join(dir, 'Default', 'Cookies')));
          if (now - lastUsed < retention) {
            keep(name, 'young', 'skippedYoung');
            continue;
          }
        }
        // Chrome is launched with the userData path as given, which may differ from the canonical one (/var vs /private/var).
        const live = await liveReason(dir, [dir, path.join(options.userDataDir, name)]);
        if (live) {
          keep(name, live, live === 'live' ? 'skippedLive' : 'skippedOther');
          continue;
        }
        const bytes = await dirBytes(dir);
        // Recheck right before removal: a browser or a first login may have appeared meanwhile.
        const stillLive = await liveReason(dir, [dir, path.join(options.userDataDir, name)]);
        if (stillLive) {
          keep(name, stillLive, stillLive === 'live' ? 'skippedLive' : 'skippedOther');
          continue;
        }
        if (await hasLogin(dir)) {
          keep(name, 'keeps-login', 'skippedKeepsLogin');
          continue;
        }
        await fs.rm(dir, { recursive: true, force: true });
        counts.removed++;
        counts.freedBytes += bytes;
      } catch (error) {
        counts.failed++;
        logger.log('WARN', `Surface profile sweep failed ${name}: ${error}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      counts.failed++;
      logger.log('WARN', `Surface profile sweep failed root: ${error}`);
    }
  } finally {
    logger.log('INFO', `Surface profile sweep ${options.endedProfileDir ? 'trigger=surface-end' : 'trigger=startup'} ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  }
}
