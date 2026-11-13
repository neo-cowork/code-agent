import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { sweepStaleIsolatedBrowserProfiles } from '../../../../../src/host/services/infra/browser/isolatedProfileSweep';
import { MANAGED_BROWSER_ISOLATED_PROFILE_PREFIX, MANAGED_BROWSER_ISOLATED_OWNER_FILE } from '../../../../../src/host/services/infra/browser/managedBrowserHelpers';
import { BROWSER_TIMEOUTS } from '../../../../../src/shared/constants/timeouts';

let tmpDir: string;
let root: string;
let live: ChildProcess;
let deadPid: number;
const old = new Date(Date.now() - BROWSER_TIMEOUTS.ISOLATED_PROFILE_SWEEP_GRACE * 2);
const logger = { log: vi.fn() };

async function profile(name: string, lock?: string, young = false) {
  const dir = path.join(root, name);
  await fs.mkdir(dir);
  const owner = JSON.stringify({ host: os.hostname(), pid: deadPid, processStartedAt: old.getTime() });
  await fs.writeFile(path.join(dir, 'data'), Buffer.alloc(4096 - Buffer.byteLength(owner)));
  await fs.writeFile(path.join(dir, MANAGED_BROWSER_ISOLATED_OWNER_FILE), owner);
  await fs.utimes(path.join(dir, MANAGED_BROWSER_ISOLATED_OWNER_FILE), old, old);
  if (lock) {
    await fs.symlink(lock, path.join(dir, 'SingletonLock'));
    await fs.lutimes(path.join(dir, 'SingletonLock'), old, old);
  }
  await fs.utimes(dir, old, young ? new Date() : old);
  return dir;
}
const deadLock = () => `${os.hostname()}-${deadPid}`;
const sweep = () => sweepStaleIsolatedBrowserProfiles({ tmpDir, logger });
const summary = () => logger.log.mock.calls.find(([level]) => level === 'INFO')?.[1];

beforeAll(async () => {
  live = spawn('sleep', ['60']);
  await new Promise<void>((resolve) => live.once('spawn', resolve));
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise<void>((resolve) => dead.once('spawn', resolve));
  deadPid = dead.pid!;
  await new Promise<void>((resolve) => dead.once('exit', () => resolve()));
});
afterAll(async () => {
  if (live.exitCode === null && live.signalCode === null) {
    const exited = new Promise<void>((resolve) => live.once('exit', () => resolve()));
    live.kill();
    await exited;
  }
});
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-sweep-test-'));
  root = path.join(tmpDir, MANAGED_BROWSER_ISOLATED_PROFILE_PREFIX);
  await fs.mkdir(root);
  logger.log.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('isolated profile sweep', () => {
  it('reclaims 120 crash leftovers and keeps only occupied live-pid profiles', async () => {
    for (let i = 0; i < 120; i++) await profile(`stale-${i}`, i % 2 ? deadLock() : undefined);
    await profile('occupied', `${os.hostname()}-${live.pid}`);
    const before = execFileSync('du', ['-sk', root], { encoding: 'utf8' }).trim().split(/\s/)[0];
    await sweep();
    const after = execFileSync('du', ['-sk', root], { encoding: 'utf8' }).trim().split(/\s/)[0];
    console.log(`fixture | direct dirs | du -sk (KiB)\nbefore | 121 | ${before}\nafter | ${(await fs.readdir(root)).length} | ${after}`);
    console.log(summary());
    expect(await fs.readdir(root)).toEqual(['occupied']);
    expect(summary()).toBe('Isolated profile sweep removed=120 freedBytes=491520 skippedLive=1 skippedYoung=0 skippedOther=0 failed=0');
    expect(Number(after)).toBeLessThan(Number(before));
  });
  it.each(['headless-shell', 'windows-lockfile'])('20-minute-old unmarked %s profile is kept by the legacy grace', async (shape) => {
    const dir = await profile('unmarked-live');
    await fs.unlink(path.join(dir, MANAGED_BROWSER_ISOLATED_OWNER_FILE));
    if (shape === 'windows-lockfile') await fs.writeFile(path.join(dir, 'lockfile'), '');
    await fs.utimes(dir, old, old);
    await sweep();
    expect(await fs.readdir(root)).toEqual(['unmarked-live']);
    expect(summary()).toContain('skippedYoung=1');
  });
  it('old live owner without SingletonLock is kept across processes', async () => {
    const dir = await profile('owned-live');
    await fs.writeFile(path.join(dir, MANAGED_BROWSER_ISOLATED_OWNER_FILE), JSON.stringify({
      host: os.hostname(), pid: live.pid, processStartedAt: old.getTime(),
    }));
    await fs.utimes(dir, old, old);
    await fs.utimes(path.join(dir, MANAGED_BROWSER_ISOLATED_OWNER_FILE), old, old);
    await sweep();
    expect(await fs.readdir(root)).toEqual(['owned-live']);
    expect(summary()).toContain('skippedLive=1');
  });
  it.each(['foreign', 'malformed', 'symlink'])('invalid %s owner metadata is kept with reason', async (shape) => {
    const dir = await profile('unknown-owner', deadLock());
    const ownerPath = path.join(dir, MANAGED_BROWSER_ISOLATED_OWNER_FILE);
    if (shape === 'foreign') {
      await fs.writeFile(ownerPath, JSON.stringify({ host: `foreign-${os.hostname()}`, pid: deadPid, processStartedAt: old.getTime() }));
    } else if (shape === 'malformed') {
      await fs.writeFile(ownerPath, '{');
    } else {
      await fs.unlink(ownerPath);
      const outside = path.join(tmpDir, 'outside-owner');
      await fs.writeFile(outside, JSON.stringify({ host: os.hostname(), pid: deadPid, processStartedAt: old.getTime() }));
      await fs.symlink(outside, ownerPath);
    }
    await fs.lutimes(ownerPath, old, old);
    await fs.utimes(dir, old, old);
    await sweep();
    expect(await fs.readdir(root)).toEqual(['unknown-owner']);
    expect(logger.log).toHaveBeenCalledWith('DEBUG', expect.stringContaining(shape === 'foreign' ? 'foreign-owner' : 'unparseable-owner'));
    expect(summary()).toContain('skippedOther=1');
  });
  it('young owner marker keeps an old profile', async () => {
    const dir = await profile('new-owner');
    await fs.utimes(path.join(dir, MANAGED_BROWSER_ISOLATED_OWNER_FILE), new Date(), new Date());
    await sweep();
    expect(await fs.readdir(root)).toEqual(['new-owner']);
    expect(summary()).toContain('skippedYoung=1');
  });
  it('live pid lock kept (real spawned process)', async () => {
    await profile('live', `${os.hostname()}-${live.pid}`);
    await sweep();
    expect(await fs.readdir(root)).toEqual(['live']);
    expect(summary()).toContain('skippedLive=1');
  });
  it('young dir kept', async () => {
    await profile('young', deadLock(), true);
    await sweep();
    expect(await fs.readdir(root)).toEqual(['young']);
    expect(summary()).toContain('skippedYoung=1');
  });
  it('young SingletonLock kept even when directory is old', async () => {
    const dir = await profile('new-lock', deadLock());
    await fs.lutimes(path.join(dir, 'SingletonLock'), new Date(), new Date());
    await sweep();
    expect(await fs.readdir(root)).toEqual(['new-lock']);
    expect(summary()).toContain('skippedYoung=1');
  });
  it('foreign-host lock kept', async () => {
    await profile('foreign', `foreign-${os.hostname()}-${deadPid}`);
    await sweep();
    expect(await fs.readdir(root)).toEqual(['foreign']);
    expect(logger.log).toHaveBeenCalledWith('DEBUG', expect.stringContaining('foreign-host'));
  });
  it('unparseable lock kept with reason', async () => {
    await profile('unknown', 'not-a-pid');
    await sweep();
    expect(await fs.readdir(root)).toEqual(['unknown']);
    expect(logger.log).toHaveBeenCalledWith('DEBUG', expect.stringContaining('unparseable-lock'));
    expect(summary()).toContain('skippedOther=1');
  });
  it('symlink pointing outside the root never deleted and outside target still exists', async () => {
    const outside = path.join(tmpDir, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep'), 'outside');
    await fs.symlink(outside, path.join(root, 'outside-link'));
    await sweep();
    expect(await fs.readlink(path.join(root, 'outside-link'))).toBe(outside);
    expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('outside');
    expect(summary()).toContain('skippedOther=1');
  });
  it('mixed 100+ leftovers preserve live young foreign and outside entries with exact counts', async () => {
    for (let i = 0; i < 101; i++) await profile(`stale-${i}`, i % 2 ? deadLock() : undefined);
    await profile('live', `${os.hostname()}-${live.pid}`);
    await profile('young', undefined, true);
    await profile('foreign', `foreign-${os.hostname()}-${deadPid}`);
    const outside = path.join(tmpDir, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, 'outside-link'));
    await sweep();
    expect((await fs.readdir(root)).sort()).toEqual(['foreign', 'live', 'outside-link', 'young']);
    expect(summary()).toBe('Isolated profile sweep removed=101 freedBytes=413696 skippedLive=1 skippedYoung=1 skippedOther=2 failed=0');
    expect((await fs.stat(outside)).isDirectory()).toBe(true);
  });
  it('current session kept even with old mtime and no lock', async () => {
    const dir = await profile('own');
    await sweepStaleIsolatedBrowserProfiles({ tmpDir, logger, currentProfileDir: dir });
    expect(await fs.readdir(root)).toEqual(['own']);
    expect(logger.log).toHaveBeenCalledWith('DEBUG', expect.stringContaining('current-session'));
  });
  it('EPERM pid probe kept conservatively', async () => {
    await profile('permission', deadLock());
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    await sweep();
    expect(await fs.readdir(root)).toEqual(['permission']);
    expect(summary()).toContain('skippedLive=1');
  });
  it('nested symlink is never followed while accounting', async () => {
    const outside = path.join(tmpDir, 'outside-data');
    await fs.writeFile(outside, 'keep');
    const dir = await profile('stale');
    await fs.symlink(outside, path.join(dir, 'nested-link'));
    await fs.utimes(dir, old, old);
    await sweep();
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readFile(outside, 'utf8')).toBe('keep');
    expect(summary()).toContain('freedBytes=4096');
  });
  it('unsafe symlink root is never traversed', async () => {
    await fs.rm(root, { recursive: true });
    const outside = path.join(tmpDir, 'outside-root');
    await fs.mkdir(outside);
    await fs.symlink(outside, root);
    await profile('keep');
    await sweep();
    expect(await fs.readdir(outside)).toEqual(['keep']);
    expect(logger.log).toHaveBeenCalledWith('DEBUG', expect.stringContaining('unsafe-root'));
  });
  it('size walk cap keeps incomplete profiles with a countable reason', async () => {
    await profile('large');
    vi.spyOn(Date, 'now').mockReturnValueOnce(Date.now()).mockReturnValueOnce(0).mockReturnValue(Number.MAX_SAFE_INTEGER);
    await sweep();
    expect(await fs.readdir(root)).toEqual(['large']);
    expect(logger.log).toHaveBeenCalledWith('DEBUG', expect.stringContaining('size-walk-budget'));
  });
  it('delete failure logs WARN and summary and preserves the directory', async () => {
    await profile('failed');
    vi.spyOn(fs, 'rm').mockRejectedValue(new Error('injected rm failure'));
    await sweep();
    expect(await fs.readdir(root)).toEqual(['failed']);
    expect(logger.log).toHaveBeenCalledWith('WARN', expect.stringContaining('failed: Error: injected rm failure'));
    expect(summary()).toContain('failed=1');
    console.log(logger.log.mock.calls.map(([level, message]) => `${level} ${message}`).join('\n'));
  });
  describe('legacy profiles without owner marker', () => {
    const DAY = 24 * 60 * 60_000;
    const legacy = async (name: string, ageDays: number, lock?: string) => {
      const dir = await profile(name, lock);
      await fs.unlink(path.join(dir, MANAGED_BROWSER_ISOLATED_OWNER_FILE));
      const when = new Date(Date.now() - ageDays * DAY);
      if (lock) await fs.lutimes(path.join(dir, 'SingletonLock'), when, when);
      await fs.utimes(dir, when, when);
      return fs.realpath(dir); // sweep reports canonical paths (macOS /var -> /private/var)
    };
    const sweepWith = (listProcessCommands: () => Promise<string>) => sweepStaleIsolatedBrowserProfiles({ tmpDir, logger, listProcessCommands });

    it('8 days old and no process: removed', async () => {
      await legacy('l8', 8);
      await sweepWith(async () => 'node server.js\n');
      expect(await fs.readdir(root)).toEqual([]);
      expect(summary()).toMatch(/^Isolated profile sweep removed=1 freedBytes=\d+ skippedLive=0 skippedYoung=0 skippedOther=0 failed=0$/);
    });
    it('6 days old: kept as young', async () => {
      await legacy('l6', 6);
      const probe = vi.fn(async () => '');
      await sweepWith(probe);
      expect(await fs.readdir(root)).toEqual(['l6']);
      expect(summary()).toContain('skippedYoung=1');
      expect(probe).not.toHaveBeenCalled();
    });
    it.each(['--user-data-dir=', '--user-data-dir="', "--user-data-dir='"])('8 days old but a process uses it (%s): kept live', async (flag) => {
      const dir = await legacy('l8-live', 8);
      await sweepWith(async () => `/x/chrome --headless ${flag}${dir}${flag.endsWith('=') ? '' : flag.slice(-1)} --foo\n`);
      expect(await fs.readdir(root)).toEqual(['l8-live']);
      expect(summary()).toContain('skippedLive=1');
    });
    it('probe failure keeps the directory and logs legacy-probe-unavailable', async () => {
      await legacy('l8-noprobe', 8);
      await sweepWith(async () => { throw new Error('ps failed'); });
      expect(await fs.readdir(root)).toEqual(['l8-noprobe']);
      expect(logger.log).toHaveBeenCalledWith('DEBUG', 'Isolated profile sweep kept l8-noprobe: legacy-probe-unavailable');
    });
    it('a prefix-sibling path is not confused with the directory', async () => {
      const a = await legacy('profile-abc', 8);
      const b = await legacy('profile-abc-2', 8);
      await sweepWith(async () => `chrome --user-data-dir=${b}\n`);
      expect(await fs.readdir(root)).toEqual(['profile-abc-2']);
      expect(a).not.toBe(b);
    });
    it('live-pid SingletonLock keeps a legacy dir with no matching process', async () => {
      await legacy('l8-lock', 8, `${os.hostname()}-${live.pid}`);
      await sweepWith(async () => '');
      expect(await fs.readdir(root)).toEqual(['l8-lock']);
      expect(summary()).toContain('skippedLive=1');
    });
    it('probe runs once per sweep for kept dirs and is refreshed for the post-measure recheck', async () => {
      await legacy('a', 8);
      await legacy('b', 9);
      const probe = vi.fn(async () => '');
      await sweepWith(probe);
      expect(probe).toHaveBeenCalledTimes(3);
    });
    it('a browser started during measure is caught by the recheck', async () => {
      const dir = await legacy('late', 8);
      let calls = 0;
      await sweepWith(async () => (++calls === 1 ? '' : `chrome --user-data-dir=${dir}\n`));
      expect(await fs.readdir(root)).toEqual(['late']);
    });
    it('marked dirs still ignore the legacy grace', async () => {
      await profile('marked');
      await sweepWith(async () => { throw new Error('must not probe'); });
      expect(await fs.readdir(root)).toEqual([]);
    });
  });
});
