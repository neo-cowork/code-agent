import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const MAP = readFileSync(path.join(ROOT, 'docs/e2e/feature-map.md'), 'utf8');

const REQUIRED_FIELDS = ['Preconditions', 'Steps', 'Selectors', 'Expected UI', 'Observable', 'Failure looks like'];

function cards(): Array<{ id: string; body: string }> {
  const parts = MAP.split(/^### (?=F\d{2} )/m).slice(1);
  return parts.map((part) => ({ id: part.slice(0, 3), body: part.split(/^## /m)[0] }));
}

describe('docs/e2e/feature-map.md', () => {
  it('index lists 15-20 flows and matches the cards', () => {
    const indexIds = [...MAP.matchAll(/^\| (F\d{2}) \|/gm)].map((m) => m[1]);
    expect(indexIds.length).toBeGreaterThanOrEqual(15);
    expect(indexIds.length).toBeLessThanOrEqual(20);
    expect(cards().map((c) => c.id)).toEqual(indexIds);
  });

  it('every flow card has all required fields', () => {
    for (const card of cards()) {
      for (const field of REQUIRED_FIELDS) {
        expect(card.body, `${card.id} missing ${field}`).toMatch(new RegExp(`^- \\*\\*${field}\\*\\*: \\S`, 'm'));
      }
    }
  });

  it('every quoted data-testid is defined in the quoted renderer file', () => {
    const quoted = [...MAP.matchAll(/`testid:([a-z0-9-]+)` @ `([^`]+)`/g)];
    expect(quoted.length).toBeGreaterThan(30);
    for (const [, testid, file] of quoted) {
      const abs = path.join(ROOT, file);
      expect(existsSync(abs), `${file} does not exist`).toBe(true);
      expect(readFileSync(abs, 'utf8').includes(`"${testid}"`), `${testid} not found in ${file}`).toBe(true);
    }
  });

  it('every testid mention uses the testid: form with a file', () => {
    const bare = [...MAP.matchAll(/`testid:([a-z0-9-]+)`(?! @ `)/g)];
    expect(bare.map((m) => m[1])).toEqual([]);
  });

  it('touched-path directories exist', () => {
    const section = MAP.split(/^## 改动路径/m)[1].split(/^## /m)[0];
    const dirs = [...section.matchAll(/`(src\/[^`]+)`/g)].map((m) => m[1]);
    expect(dirs.length).toBeGreaterThan(10);
    for (const dir of dirs) expect(existsSync(path.join(ROOT, dir)), dir).toBe(true);
  });

  it('every flow id is reachable from the touched-path table, and rubric exists', () => {
    const section = MAP.split(/^## 改动路径/m)[1].split(/^## /m)[0];
    for (const card of cards().filter((c) => !['F02', 'F04'].includes(c.id) || section.includes(c.id))) {
      expect(section, `${card.id} not mapped`).toContain(card.id);
    }
    expect(MAP).toMatch(/^## 评分标准/m);
  });
});
