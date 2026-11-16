import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/i18n-plural-ratchet.mjs');
const roots: string[] = [];

function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'i18n-plural-ratchet-'));
  roots.push(root);
  mkdirSync(join(root, 'src/renderer/i18n'), { recursive: true });
  writeFileSync(join(root, 'src/renderer/i18n/en.ts'), source);
  return root;
}

function baseline(root: string, counts: Record<string, number>): void {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/i18n-plural-baseline.json'), JSON.stringify(counts));
}

function run(root: string) {
  return spawnSync(process.execPath, [script, '--repo-root', root], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('i18n-plural-ratchet', () => {
  it('rejects parenthesized plurals and hard plurals outside a plural pair', () => {
    const result = run(fixture("export const en = { bad: '{count} agent(s)', alsoBad: '{count} agents' };\n"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('contains forbidden literal "(s)"');
    expect(result.stderr).toContain('uses hard plural after a count placeholder');
  });

  it('accepts a singular/plural pair', () => {
    const result = run(fixture("export const en = { good: { one: '{count} agent', other: '{count} agents' } };\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no unbaselined count phrases');
  });

  it('rejects hard plurals across the broad noun list, including after connector words', () => {
    const result = run(fixture([
      "export const en = {",
      "  a: '{count} steps',",
      "  b: '{count} more files not shown',",
      "  c: 'About {count} sub-agent calls',",
      "  d: '{count} times',",
      "  pair: { one: '{count} step', other: '{count} steps' },",
      "};",
      "",
    ].join('\n')));
    expect(result.status).toBe(1);
    for (const text of ['{count} steps', '{count} more files not shown', 'About {count} sub-agent calls', '{count} times']) {
      expect(result.stderr).toContain(`uses hard plural after a count placeholder: ${text}`);
    }
    // The pair's other branch is the sanctioned plural form — exactly four findings.
    expect(result.stderr.match(/uses hard plural/g)).toHaveLength(4);
  });

  it('exempts the group aggregation tables backed by groupSingular', () => {
    const result = run(fixture([
      "export const en = {",
      "  toolStepHumanize: {",
      "    groupSingular: { completed: { explored: '{count} time' } },",
      "    group: { explored: '{count} times' },",
      "  },",
      "};",
      "",
    ].join('\n')));
    expect(result.status, result.stderr).toBe(0);
  });

  it('does not flag zh copy that embeds an English loanword', () => {
    const result = run(fixture("export const en = { compactionTokensSaved: '节省 {count} tokens' };\n"));
    expect(result.status, result.stderr).toBe(0);
  });

  it('flags scope/class nouns and accepts them as a one/other pair', () => {
    const bad = fixture("export const en = { a: '{count} data scopes', b: '{count} allowed action classes' };\n");
    baseline(bad, {});
    expect(run(bad).status).toBe(1);
    const ok = fixture("export const en = { a: { one: '{count} data scope', other: '{count} data scopes' } };\n");
    baseline(ok, {});
    expect(run(ok).status).toBe(0);
  });

  it('fails on a hard plural in a file with no baseline entry', () => {
    const root = fixture("export const en = { bad: '{count} steps' };\n");
    baseline(root, {});
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not in baseline');
  });

  it('allows baselined strings but rejects baseline growth', () => {
    const source = "export const en = { a: '{count} steps', b: '{count} files' };\n";
    const allowed = fixture(source);
    baseline(allowed, { 'src/renderer/i18n/en.ts': 2 });
    const ok = run(allowed);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('baseline remaining=2');

    const capped = fixture(source);
    baseline(capped, { 'src/renderer/i18n/en.ts': 1 });
    const grown = run(capped);
    expect(grown.status).toBe(1);
    expect(grown.stderr).toContain('exceed baseline');
  });
});
