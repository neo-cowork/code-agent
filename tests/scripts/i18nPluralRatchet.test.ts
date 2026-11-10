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
    expect(result.stdout).toContain('no forbidden count phrases');
  });
});
