// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function check(source: string, translation = '') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'inline-count-'));
  try {
    const dir = path.join(root, 'src/renderer/components');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'Count.tsx'), source);
    const i18n = path.join(root, 'src/renderer/i18n');
    mkdirSync(i18n, { recursive: true });
    writeFileSync(path.join(i18n, 'copy.ts'), translation);
    return spawnSync(process.execPath, ['scripts/i18n-plural-ratchet.mjs', '--repo-root', root], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('component inline line-count ratchet', () => {
  it.each([
    '<span>{n} lines</span>',
    "<span>{n} line{n > 1 ? 's' : ''}</span>",
    '<span>{n}\n lines</span>',
    'const label = `${n} lines`; const View = () => <span>{label}</span>;',
    'const View = () => <span>{`${n}\n lines`}</span>;',
    "<span>line{n > 1 ? 's' : ''}</span>",
  ])('rejects inline count copy: %s', (source) => {
    const result = check(source);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rendered inline count must use i18n');
    expect(result.stderr).toContain('src/renderer/components/Count.tsx:');
  });

  it('ignores comments, parser strings and localized JSX', () => {
    const result = check('// {n} lines\nconst parser = "lines";\nconst View = () => <span>{interpolatePlural(t.codeBlock.lineCount, n)}</span>;');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('inline count hits=0; allowed=0');
  });

  it.each(["const label = '{count} agents';", "const label = 'agent(s)';"])(
    'keeps the original i18n phrase checks active: %s', (translation) => {
      const result = check('<span>{t.label}</span>', translation);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('src/renderer/i18n/copy.ts:');
    },
  );

  it('allows explicit plural forms in shared i18n', () => {
    const result = check('<span>{t.label}</span>', "const label = {one: '{count} agent', other: '{count} agents'};");
    expect(result.status).toBe(0);
  });
});
