import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture(source: string, entries: unknown[] = []) {
  const folder = mkdtempSync(path.join(tmpdir(), 'renderer-dates-'));
  folders.push(folder);
  writeFileSync(path.join(folder, 'Screen.tsx'), source);
  writeFileSync(path.join(folder, 'Ignored.test.tsx'), 'new Date().toLocaleString();');
  const allowlist = path.join(folder, 'allowlist.json');
  writeFileSync(allowlist, JSON.stringify(entries));
  return spawnSync(process.execPath, ['scripts/check-renderer-date-locales.mjs', '--root', folder, '--allowlist', allowlist], { encoding: 'utf8' });
}
describe('renderer bare Date locale ratchet', () => {
  it('passes the non-test renderer tree with reasoned, bounded exceptions', () => {
    const result = spawnSync(process.execPath, ['scripts/check-renderer-date-locales.mjs'], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS renderer date locales');
  });
  it('rejects new Date, date, d, *At and Date-initialized receivers in a temp file', () => {
    const result = fixture(`
      const created = new Date();
      new Date().toLocaleString();
      date.toLocaleString('en-US');
      (d as Date).toLocaleString();
      lastRunAt.toLocaleString();
      created.toLocaleString();
      arbitrary.toLocaleDateString();
      arbitrary.toLocaleTimeString();
    `);
    expect(result.status).toBe(1);
    expect(result.stderr.match(/bare Date locale call/g)).toHaveLength(7);
    console.log(result.stderr);
  });
  it('rejects an allowlist entry without a reason', () => {
    const result = fixture('date.toLocaleTimeString();', [{ file: 'Screen.tsx', call: 'date.toLocaleTimeString()', count: 1 }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('allowlist entry needs a one-line reason');
    console.log(result.stderr);
  });
  it('does not match comments, strings, test files or numeric formatting', () => {
    const result = fixture(`// new Date().toLocaleString()
      const text = 'date.toLocaleString()';
      total.toLocaleString(); count.toLocaleString('en-US');`);
    expect(result.status).toBe(0);
  });
  it('rejects allowlist growth beyond the recorded site baseline', () => {
    const result = fixture('date.toLocaleTimeString();', [{ file: 'Screen.tsx', call: 'date.toLocaleTimeString()', count: 22, reason: 'time only' }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exceeds baseline 21');
  });
});
