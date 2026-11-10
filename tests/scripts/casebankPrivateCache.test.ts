import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPrivateCheckCached } from '../../scripts/lib/casebank-private-cache.mjs';

let fixture: string;
let root: string;
let privateRoot: string;
let cacheDir: string;
const write = (name: string, content: string) => {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, content);
};
const run = vi.fn(async () => {});
const check = () => runPrivateCheckCached({ root, privateRoot, cacheDir, entryPoints: ['a.ts'], run });

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'private-check-cache-'));
  root = path.join(fixture, 'repo');
  privateRoot = path.join(fixture, 'private');
  cacheDir = path.join(fixture, 'cache');
  for (const [name, content] of Object.entries({
    '.claude/test-cases/drafts/case.yaml': 'cases: a',
    'a.ts': "import { b } from './b'; console.log(b);",
    'b.ts': "export { c as b } from './c';",
    'c.ts': 'export const c = 1;',
    'scripts/ci/check-casebank-answers.mjs': '// checker',
    'scripts/lib/casebank-private-cache.mjs': '// helper',
    'package-lock.json': '{}',
    'tsconfig.json': '{}',
  })) write(path.join(root, name), content);
  write(path.join(privateRoot, 'answers/case.yaml'), 'answer: a');
  run.mockReset();
  run.mockResolvedValue(undefined);
});
afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

describe('private check content cache', () => {
  it('(i) runs first, reuses identical inputs without calling run', async () => {
    const first = await check();
    expect(first.mode).toBe('ran');
    expect(first.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await check()).toEqual({ mode: 'reused', inputHash: first.inputHash });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['(ii) public case', () => path.join(root, '.claude/test-cases/drafts/case.yaml')],
    ['(iii) private answers', () => path.join(privateRoot, 'answers/case.yaml')],
    ['(iv) transitive module', () => path.join(root, 'c.ts')],
  ])('%s one-character edit forces a rerun', async (_label, target) => {
    const first = await check();
    const file = target();
    const content = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, content.replace(/a|1/, (character) => character === '1' ? '2' : 'b'));
    const second = await check();
    expect(second.mode).toBe('ran');
    expect(second.inputHash).not.toBe(first.inputHash);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('(v) failure writes nothing, reports ran metadata and runs again', async () => {
    run.mockRejectedValueOnce(new Error('check failed'));
    await expect(check()).rejects.toMatchObject({ message: 'check failed', privateCheck: { mode: 'ran', inputHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(fs.existsSync(path.join(cacheDir, 'private-check.json'))).toBe(false);
    expect((await check()).mode).toBe('ran');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('(vi) corrupt cache forces a real run', async () => {
    await check();
    fs.writeFileSync(path.join(cacheDir, 'private-check.json'), '{broken');
    expect((await check()).mode).toBe('ran');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('(vii) esbuild resolution failure always runs and never caches', async () => {
    await check();
    write(path.join(root, 'c.ts'), "export { missing } from './absent';");
    expect((await check()).mode).toBe('ran');
    expect((await check()).mode).toBe('ran');
    expect(run).toHaveBeenCalledTimes(3);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(cacheDir, 'private-check.json'), 'utf8')))).toHaveLength(1);
  });
  it('public eval-splits existence invalidates the pass', async () => {
    await check();
    write(path.join(root, '.claude/eval-splits.json'), '{}');
    expect((await check()).mode).toBe('ran');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('check, helper, lockfile and tsconfig changes invalidate passes', async () => {
    await check();
    for (const name of ['scripts/ci/check-casebank-answers.mjs', 'scripts/lib/casebank-private-cache.mjs', 'package-lock.json', 'tsconfig.json']) {
      fs.appendFileSync(path.join(root, name), ' ');
      expect((await check()).mode).toBe('ran');
    }
    expect(run).toHaveBeenCalledTimes(5);
  });
  it('keeps only the newest passed hashes', async () => {
    for (let index = 0; index < 10; index++) {
      write(path.join(root, 'c.ts'), `export const c = ${index};`);
      await check();
      // Make chronology deterministic even on filesystems with coarse clocks.
      const file = path.join(cacheDir, 'private-check.json');
      const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const hash of Object.keys(entries)) if (entries[hash] > 100) entries[hash] = index;
      fs.writeFileSync(file, JSON.stringify(entries));
    }
    const entries = JSON.parse(fs.readFileSync(path.join(cacheDir, 'private-check.json'), 'utf8'));
    expect(Object.values(entries).sort()).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect((await check()).mode).toBe('reused');
  });
  it('cache write failure warns without failing the check', async () => {
    write(cacheDir, 'not a directory');
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await check()).mode).toBe('ran');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('write failed'));
    } finally { warning.mockRestore(); }
  });
  it('inputs changed during a successful check are not cached', async () => {
    run.mockImplementationOnce(async () => { fs.appendFileSync(path.join(privateRoot, 'answers/case.yaml'), 'b'); });
    await check();
    expect(fs.existsSync(path.join(cacheDir, 'private-check.json'))).toBe(false);
    expect((await check()).mode).toBe('ran');
  });
});
