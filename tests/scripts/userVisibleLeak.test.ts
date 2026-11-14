import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
// @ts-expect-error -- Public JS gate entry point has no declaration file.
import { scan } from '../../scripts/ci/user-visible-leak.mjs';

const roots: string[] = [];
const baselineFile = 'scripts/ci/user-visible-leak-baseline.json';
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function makeRepo(files: Record<string, string>, baseline: { file: string; value: string }[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'user-visible-leak-'));
  roots.push(root);
  for (const dir of ['src/renderer', 'src/shared', 'scripts/ci']) mkdirSync(join(root, dir), { recursive: true });
  for (const [file, content] of Object.entries({ ...files, [baselineFile]: JSON.stringify(baseline) })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}
const file = 'src/renderer/copy.tsx';
const tokens = ['-1743', 'osascript', 'Apple events', 'AppleEvents', 'TCC', '/login', '/model'];
describe('user-visible-leak', () => {
  it.each(tokens)('flags %s in literals and English/Chinese JSX text', (token) => {
    const report = scan(makeRepo({ [file]: `const label = 'Try ${token}';\nconst view = <p>Try ${token}</p>;\nconst zh = <p>请使用 ${token}</p>;` }));
    for (const line of [1, 2, 3]) {
      expect(report.violations).toContainEqual(expect.objectContaining({ file, line, token }));
    }
  });
  it('ignores comments, module specifiers, relative paths, URLs and longer command names', () => {
    const report = scan(makeRepo({ [file]: [
      '// -1743 osascript Apple events TCC /login /model',
      '/* TCC */',
      "import x from './model';",
      "import y from 'osascript';",
      "export { z } from './TCC';",
      "const lazy = import('./model');",
      "const required = require('osascript');",
      "type M = import('./TCC').M;",
      "const paths = ['./model', '../login', '@shared/model', '/models', '/login-help', 'https://example.test/login', 'https://example.test/model?x=1'];",
    ].join('\n') }));
    expect(report.violations).toEqual([]);
  });
  it('matches commands in punctuation and CJK copy, case-insensitively', () => {
    const report = scan(makeRepo({ [file]: "const label = '使用/login，或（/MODEL）: OSASCRIPT appleevents tcc /model.';" }));
    expect(report.violations.map((hit: { token: string }) => hit.token)).toEqual(['/login', '/MODEL', 'OSASCRIPT', 'appleevents', 'tcc', '/model']);
  });
  it('requires a real per-line exemption comment with a reason', () => {
    const report = scan(makeRepo({ [file]: [
      "const allowed = 'osascript'; // leak-allow: documentation preview",
      "const empty = 'TCC'; // leak-allow:",
      "const spoof = '-1743 // leak-allow: not a comment';",
      'const multiline = `safe',
      'Apple events',
      'TCC`; // leak-allow: only this physical line',
    ].join('\n') }));
    expect(report.violations.map((hit: { line: number }) => hit.line)).toEqual([2, 3, 5]);
  });
  it('baselines exact file and whole string, independent of line number; new copy fails', () => {
    const baseline = [{ file, value: 'Try TCC' }];
    const root = makeRepo({ [file]: "\n\nconst old = 'Try TCC';\nconst added = 'Try osascript';" }, baseline);
    const report = scan(root);
    expect(report.baselineHits).toBe(1);
    expect(report.violations).toEqual([expect.objectContaining({ file, line: 4, token: 'osascript' })]);
    writeFileSync(join(root, file), "\nconst old = 'Try TCC';");
    expect(scan(root).violations).toEqual([]);
    writeFileSync(join(root, file), "const old = 'Changed TCC';");
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(scan(root).violations).toHaveLength(1);
  });
  it('does not transfer a baseline allowance to another file', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = scan(makeRepo({ 'src/shared/new.ts': "const label = 'Try TCC';" }, [{ file, value: 'Try TCC' }]));
    expect(report.baselineHits).toBe(0);
    expect(report.violations).toHaveLength(1);
  });
  it('removed baseline entry only warns to tighten baseline', () => {
    const report = scan(makeRepo({ [file]: "const label = 'Safe';" }, [{ file, value: 'Old TCC' }]));
    expect(report.violations).toEqual([]);
    expect(report.warnings).toEqual(['tighten baseline: src/renderer/copy.tsx "Old TCC"']);
  });
  it('excludes test files and declarations', () => {
    const report = scan(makeRepo({
      [file]: "const safe = 'Safe';",
      'src/shared/a.test.ts': "const bad = 'TCC';",
      'src/shared/b.spec.tsx': '<p>osascript</p>',
      'src/shared/a.d.ts': "type Bad = 'TCC';",
      'src/renderer/__tests__/a.ts': "const bad = '-1743';",
      'src/renderer/tests/a.tsx': '<p>/login</p>',
    }));
    expect(report.fileCount).toBe(1);
    expect(report.violations).toEqual([]);
  });
  it('fails loudly for an empty scan root', () => {
    expect(() => scan(makeRepo({}))).toThrow('Scanned 0 target source files');
  });
  it('fails loudly if a scan directory or baseline is missing', () => {
    const root = makeRepo({ [file]: "const safe = 'Safe';" });
    rmSync(join(root, 'src/shared'), { recursive: true });
    expect(() => scan(root)).toThrow();
    rmSync(join(root, baselineFile));
    expect(() => scan(root)).toThrow();
  });
  it('passes the repository ratchet while allowing baseline cleanup', () => {
    const report = scan(resolve(__dirname, '../..'));
    expect(report.fileCount).toBeGreaterThan(0);
    expect(report.baselineHits).toBeLessThanOrEqual(7);
    expect(report.violations).toEqual([]);
  });
});
