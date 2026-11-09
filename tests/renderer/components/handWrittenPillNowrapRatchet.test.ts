import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import baseline from './handWrittenPillNowrapBaseline.json';

const RENDERER_ROOT = path.resolve(process.cwd(), 'src/renderer');
const BASELINE_PATH = path.resolve(process.cwd(), 'tests/renderer/components/handWrittenPillNowrapBaseline.json');

function listTsx(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listTsx(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

/** 一行 className 看起来像手写 pill：rounded(-full|-sm|-md|-lg|-xl) + text-xs|[10px]|[11px] + px-，且没有任何防折行类。 */
function isUnprotectedPillLine(line: string): boolean {
  if (!line.includes('className') || line.includes('<Badge')) return false;
  const tokens = line.split(/[\s"'`{}=]+/);
  const rounded = tokens.some((t) => /^rounded(-(full|sm|md|lg|xl))?$/.test(t));
  const small = tokens.some((t) => t === 'text-xs' || t === 'text-[10px]' || t === 'text-[11px]');
  const padded = tokens.some((t) => t.startsWith('px-'));
  if (!rounded || !small || !padded) return false;
  return !tokens.some((t) => t === 'whitespace-nowrap' || t === 'shrink-0' || t === 'truncate');
}

function scan(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of listTsx(RENDERER_ROOT)) {
    const n = readFileSync(file, 'utf8').split('\n').filter(isUnprotectedPillLine).length;
    if (n > 0) counts[path.relative(process.cwd(), file)] = n;
  }
  return counts;
}

describe('hand-written pill nowrap ratchet', () => {
  const counts = scan();
  const base: Record<string, number> = baseline.files;

  it('no file gains unprotected pills (new files must have 0)', () => {
    const regressions = Object.entries(counts)
      .filter(([file, n]) => n > (base[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} > baseline ${base[file] ?? 0} (add whitespace-nowrap / shrink-0 / truncate)`);
    expect(regressions).toEqual([]);
  });

  it('baseline only goes down: lower the JSON when you protect a pill', () => {
    const stale = Object.entries(base)
      .filter(([file, n]) => (counts[file] ?? 0) < n)
      .map(([file, n]) => `${file}: baseline ${n} but only ${counts[file] ?? 0} left — lower handWrittenPillNowrapBaseline.json`);
    expect(stale).toEqual([]);
  });

  it('the scanner flags a bare pill and accepts a protected one', () => {
    expect(isUnprotectedPillLine('<span className="rounded-full px-2 py-1 text-xs">x</span>')).toBe(true);
    expect(isUnprotectedPillLine('<span className="whitespace-nowrap rounded-full px-2 py-1 text-xs">x</span>')).toBe(false);
    expect(isUnprotectedPillLine('<Badge className="rounded-full px-2 text-xs">x</Badge>')).toBe(false);
  });
});

if (process.env.UPDATE_PILL_BASELINE === '1') {
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ files: scan() }, null, 2)}\n`);
}
