import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepSurfaceBrowserProfiles } from '../../../../src/host/services/infra/browser/surfaceProfileSweep';
import { BROWSER_TIMEOUTS } from '../../../../src/shared/constants/timeouts';

const P = 'managed-browser-profile-surface-';
const DAY = 24 * 60 * 60_000;
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'surface-sweep-')));
  roots.push(root);
  const logs: string[] = [];
  const logger = { log: (level: string, msg: string) => { logs.push(`[${level}] ${msg}`); } } as never;
  const mk = (name: string, opts: { ageDays?: number; files?: string[] } = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'Default', 'Network'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Local State'), 'x'.repeat(100));
    for (const f of opts.files ?? []) fs.writeFileSync(path.join(dir, f), 'secret');
    const t = new Date(Date.now() - (opts.ageDays ?? 30) * DAY);
    for (const p of [path.join(dir, 'Default', 'Network'), path.join(dir, 'Default'), dir, ...(opts.files ?? []).map((f) => path.join(dir, f))]) fs.utimesSync(p, t, t);
    return dir;
  };
  const run = (extra: Partial<Parameters<typeof sweepSurfaceBrowserProfiles>[0]> = {}) => sweepSurfaceBrowserProfiles({
    userDataDir: root, logger, listProcessCommands: async () => '', ...extra,
  });
  return { root, logs, mk, run, left: () => fs.readdirSync(root).sort() };
}

describe('sweepSurfaceBrowserProfiles', () => {
  it('uses a 7-day retention constant', () => {
    expect(BROWSER_TIMEOUTS.SURFACE_PROFILE_SWEEP_RETENTION).toBe(7 * DAY);
  });

  it('deletes old idle login-free dirs', async () => {
    const t = setup();
    t.mk(`${P}old`);
    await t.run();
    expect(t.left()).toEqual([]);
    expect(t.logs.at(-1)).toMatch(/removed=1 freedBytes=100 .*skippedLive=0/);
  });

  it('keeps young dirs', async () => {
    const t = setup();
    t.mk(`${P}young`, { ageDays: 1 });
    await t.run();
    expect(t.left()).toEqual([`${P}young`]);
    expect(t.logs.at(-1)).toContain('skippedYoung=1');
  });

  it.each([['Default/Cookies'], ['Default/Login Data'], ['Default/Network/Cookies'], ['Cookies']])('keeps-login: %s', async (file) => {
    const t = setup();
    const dir = t.mk(`${P}login`, { files: [file] });
    await t.run();
    expect(fs.existsSync(dir)).toBe(true);
    expect(t.logs.at(-1)).toContain('skippedKeepsLogin=1');
    expect(t.logs).toContain(`[DEBUG] Surface profile sweep kept ${P}login: keeps-login`);
  });

  it('keeps a dir whose SingletonLock pid is alive', async () => {
    const t = setup();
    const dir = t.mk(`${P}lock`);
    fs.symlinkSync(`${os.hostname()}-4242`, path.join(dir, 'SingletonLock'));
    const t2 = new Date(Date.now() - 30 * DAY);
    fs.lutimesSync(path.join(dir, 'SingletonLock'), t2, t2);
    fs.utimesSync(dir, t2, t2);
    await t.run({ isPidAlive: (pid) => pid === 4242 });
    expect(fs.existsSync(dir)).toBe(true);
    expect(t.logs.at(-1)).toContain('skippedLive=1');
  });

  it('removes a dir whose SingletonLock pid is dead', async () => {
    const t = setup();
    const dir = t.mk(`${P}stale`);
    fs.symlinkSync(`${os.hostname()}-4242`, path.join(dir, 'SingletonLock'));
    const old = new Date(Date.now() - 30 * DAY);
    fs.lutimesSync(path.join(dir, 'SingletonLock'), old, old);
    fs.utimesSync(dir, old, old);
    await t.run({ isPidAlive: () => false });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('keeps a dir referenced by a ps command line', async () => {
    const t = setup();
    const dir = t.mk(`${P}ps`);
    await t.run({ listProcessCommands: async () => `/Chrome --user-data-dir=${dir} --headless\n` });
    expect(fs.existsSync(dir)).toBe(true);
    expect(t.logs.at(-1)).toContain('skippedLive=1');
  });

  it('keeps the dir when ps is unavailable', async () => {
    const t = setup();
    const dir = t.mk(`${P}nops`);
    await t.run({ listProcessCommands: async () => { throw new Error('no ps'); } });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('never touches the unsuffixed personal profile or other names', async () => {
    const t = setup();
    t.mk('managed-browser-profile');
    t.mk('managed-browser-profile-agent-x');
    t.mk('other');
    await t.run();
    expect(t.left()).toEqual(['managed-browser-profile', 'managed-browser-profile-agent-x', 'other']);
  });

  it('skips symlinks and out-of-root targets with reason not-in-root', async () => {
    const t = setup();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'surface-outside-')));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    fs.symlinkSync(outside, path.join(t.root, `${P}link`));
    await t.run();
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    expect(fs.lstatSync(path.join(t.root, `${P}link`)).isSymbolicLink()).toBe(true);
    expect(t.logs.at(-1)).toContain('skippedNotInRoot=1');
    expect(t.logs).toContain(`[DEBUG] Surface profile sweep kept ${P}link: not-in-root`);
  });

  it('surface-end trigger ignores age but still keeps login and live dirs, and only touches the ended dir', async () => {
    const t = setup();
    const ended = t.mk(`${P}ended`, { ageDays: 0 });
    const other = t.mk(`${P}other`, { ageDays: 0 });
    const loginEnded = t.mk(`${P}ended-login`, { ageDays: 0, files: ['Default/Cookies'] });
    await t.run({ endedProfileDir: ended });
    expect(fs.existsSync(ended)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(t.logs.at(-1)).toContain('trigger=surface-end');
    await t.run({ endedProfileDir: loginEnded });
    expect(fs.existsSync(loginEnded)).toBe(true);
    await t.run({ endedProfileDir: other, listProcessCommands: async () => `x --user-data-dir=${other}\n` });
    expect(fs.existsSync(other)).toBe(true);
  });

  it('seeded 21-dir run keeps only login/live/young dirs and the personal profile', async () => {
    const t = setup();
    t.mk('managed-browser-profile', { files: ['Default/Cookies'] });
    for (let i = 0; i < 10; i++) t.mk(`${P}empty${i}`);
    for (let i = 0; i < 4; i++) t.mk(`${P}login${i}`, { files: [['Default/Cookies', 'Default/Login Data', 'Default/Network/Cookies', 'Cookies'][i]] });
    for (let i = 0; i < 3; i++) t.mk(`${P}young${i}`, { ageDays: 2 });
    const live = t.mk(`${P}live`);
    t.mk(`${P}live2`);
    t.mk(`${P}empty-last`);
    const bytes = (d: string) => fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).reduce((n, e) => n + fs.statSync(path.join(e.parentPath, e.name)).size, 0);
    const before = fs.readdirSync(t.root).length;
    const beforeBytes = bytes(t.root);
    await t.run({ listProcessCommands: async () => `c --user-data-dir=${live}\nc --user-data-dir=${path.join(t.root, `${P}live2`)}\n` });
    const afterBytes = bytes(t.root);
    console.log(`SEED before=${before} dirs/${beforeBytes}B after=${t.left().length} dirs/${afterBytes}B`, t.logs.at(-1));
    expect(t.left()).toEqual([
      'managed-browser-profile', `${P}live`, `${P}live2`, ...[0, 1, 2, 3].map((i) => `${P}login${i}`), ...[0, 1, 2].map((i) => `${P}young${i}`),
    ].sort());
    expect(before).toBe(21);
  });
});
