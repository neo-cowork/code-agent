import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractStrings } from '../../../scripts/check-copy.mjs';

// English uses "Space"/"Spaces" and "cloud Space". Retired spellings are built by
// concatenation so the gate does not match itself. See docs/design/en-copy-glossary.md.
const COLLAB = new RegExp('collaboration' + ' spaces?', 'i');
const CLOUD_LOWER = new RegExp('cloud' + ' spaces?');

const srcRoot = resolve(__dirname, '../../../src');

const HOST_FILES = [
  'host/tools/modules/planning/spaceCreate.schema.ts',
  'host/tools/modules/planning/spaceList.schema.ts',
  'host/tools/modules/planning/spaceQuery.schema.ts',
  'host/tools/modules/planning/spaceCreate.ts',
  'host/tools/modules/planning/spaceQuery.ts',
  'host/prompts/spaceContextPrompt.ts',
  'host/ipc/project.ipc.ts',
];

function scopedFiles(): string[] {
  const dirs = ['renderer/i18n', 'shared/i18n'];
  const files = dirs.flatMap((d) =>
    readdirSync(join(srcRoot, d))
      .filter((n) => /\.ts$/.test(n))
      .map((n) => `${d}/${n}`),
  );
  return [...files, ...HOST_FILES];
}

function findRetired(source: string): string[] {
  return extractStrings(source)
    .map((s: { value: string }) => s.value)
    .filter((text: string) => COLLAB.test(text) || CLOUD_LOWER.test(text));
}

describe('en Space naming gate', () => {
  it('no English string in scope uses a retired spelling', () => {
    const offenders: string[] = [];
    for (const file of scopedFiles()) {
      const hits = findRetired(readFileSync(join(srcRoot, file), 'utf8'));
      if (hits.length > 0) offenders.push(`${file}: ${hits[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('flags both retired spellings, ignores comments, cloud Space and collaboration service', () => {
    const source = [
      `// ${'collaboration' + ' space'} only in a comment`,
      `const a = 'Upgrade to ${'cloud' + ' space'}';`,
      `const b = 'Use a ${'Collaboration' + ' Spaces'} here';`,
      `const c = 'Upgrade to cloud Space';`,
      `const d = 'The collaboration service is offline';`,
    ].join('\n');
    expect(findRetired(source)).toHaveLength(2);
    expect(findRetired(`// ${'cloud' + ' space'}\nconst a = 'cloud Space';`)).toEqual([]);
  });
});
