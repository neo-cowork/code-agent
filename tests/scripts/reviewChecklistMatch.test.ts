import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/review/checklist-match.mjs');
const FIXTURES = join(ROOT, 'tests/fixtures/review-checklist');
const tmp = mkdtempSync(join(tmpdir(), 'rc-match-'));

interface Hit {
  id: string;
  matches: { file: string; matched: string[] }[];
}

function run(args: string[], input?: string) {
  return spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', input });
}

function hitIds(diff: string, checklist?: string): string[] {
  const args = ['--json', ...(checklist ? ['--checklist', checklist] : [])];
  const r = run(args, diff);
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout).hits as Hit[]).map((h) => h.id);
}

function fileDiff(path: string, added: string[] = [], removed: string[] = []): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,1 @@',
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    '',
  ].join('\n');
}

function entry(id: string, lines: string[]): string {
  return ['```rc', `id: ${id}`, ...lines, '```', ''].join('\n');
}

describe('checklist-match', () => {
  it('(a) a path-glob trigger matches exactly the expected ids', () => {
    const ids = hitIds(fileDiff('src/host/tools/shell/sandboxEscalation.ts', ['const a = 1;']));
    expect(ids).toEqual(['RC-03']);
  });

  it('(b) a regex-only trigger matches on added lines in any file', () => {
    const ids = hitIds(fileDiff('scripts/some-install.sh', ['  pkill -f "Agent Neo"']));
    expect(ids).toEqual(['RC-05']);
  });

  it('(b2) the allowed `?? Date.now()` form does not trip RC-01, the bare form does', () => {
    const repo = 'src/host/services/core/repositories/FooRepository.ts';
    expect(hitIds(fileDiff(repo, ['const t = updatedAt ?? Date.now();']))).toEqual([]);
    expect(hitIds(fileDiff(repo, ['const t = Date.now();']))).toEqual(['RC-01']);
  });

  it('(c) a diff touching nothing relevant matches 0 entries', () => {
    expect(hitIds(fileDiff('src/host/utils/format.ts', ['export const x = 1;']))).toEqual([]);
  });

  it('(d) a malformed entry makes the script exit 2 and name the id', () => {
    const bad = join(tmp, 'bad.md');
    writeFileSync(bad, entry('RC-77', ['paths: src/**', 'check: x', 'incident: a ; b']));
    const r = run(['--checklist', bad, '--diff', '/dev/null']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('RC-77');
    expect(r.stderr).toContain('expiry');

    const badRe = join(tmp, 'badre.md');
    writeFileSync(badRe, entry('RC-78', ['diff: /(unclosed/', 'check: x', 'incident: a ; b', 'expiry: never']));
    const r2 = run(['--checklist', badRe, '--diff', '/dev/null']);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain('RC-78');
  });

  it('paths + diff are ANDed and `!` excludes a path', () => {
    const cl = join(tmp, 'and.md');
    writeFileSync(
      cl,
      entry('RC-90', ['paths: src/** | !src/gen/**', 'diff: /FORBIDDEN/', 'check: x', 'incident: a ; b', 'expiry: never']),
    );
    expect(hitIds(fileDiff('src/a.ts', ['FORBIDDEN']), cl)).toEqual(['RC-90']);
    expect(hitIds(fileDiff('lib/a.ts', ['FORBIDDEN']), cl)).toEqual([]);
    expect(hitIds(fileDiff('src/gen/a.ts', ['FORBIDDEN']), cl)).toEqual([]);
    expect(hitIds(fileDiff('src/a.ts', ['fine']), cl)).toEqual([]);
  });

  it('(e) every real entry has all required fields, a unique id, ≥2 incident references and a parseable trigger', () => {
    const r = run(['--list']);
    expect(r.status, r.stderr).toBe(0);
    const rows = JSON.parse(r.stdout) as {
      id: string;
      check: string;
      incident: string;
      expiry: string;
      paths: string | null;
      diff: string | null;
      diffDel: string | null;
    }[];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.length).toBeLessThanOrEqual(25);
    expect(new Set(rows.map((x) => x.id)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.id).toMatch(/^RC-\d{2}$/);
      expect(row.check.length, row.id).toBeGreaterThan(10);
      expect(row.expiry.length, row.id).toBeGreaterThan(5);
      expect(row.incident.split(' ; ').length, `${row.id} needs 2 incident refs`).toBeGreaterThanOrEqual(2);
      expect(row.paths || row.diff || row.diffDel, `${row.id} has no trigger`).toBeTruthy();
    }
    const header = readFileSync(join(ROOT, 'docs/review/reliability-checklist.md'), 'utf8');
    expect(header).toContain('季度修剪规则');
    expect(header).toContain('该季度内没有命中过任何 PR');
  });

  describe('(f) replay of historical fix diffs', () => {
    const cases: [string, string][] = [
      ['RC-03', 'RC-03-sandbox-a991d633c.diff'],
      ['RC-04', 'RC-04-shutdown-dd1569ddb.diff'],
      ['RC-05', 'RC-05-pkill-02762b5cf.diff'],
      ['RC-13', 'RC-13-permission-2c3d19fa2.diff'],
    ];
    for (const [id, file] of cases) {
      it(`${file} hits ${id}`, () => {
        const diff = readFileSync(join(FIXTURES, file), 'utf8');
        expect(hitIds(diff)).toContain(id);
      });
    }

    it('a typical mixed diff hits 3–10 entries', () => {
      const mixed = cases.map(([, f]) => readFileSync(join(FIXTURES, f), 'utf8')).join('\n');
      const n = hitIds(mixed).length;
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(10);
    });
  });
});
