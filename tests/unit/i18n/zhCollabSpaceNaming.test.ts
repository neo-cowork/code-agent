import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractStrings } from '../../../scripts/check-copy.mjs';

// 中文「协作空间」功能只有一个名字。别名由拼接构造，别让门匹配到自己。
const ALIAS = '协' + '同空间';
const CANONICAL = '协' + '作空间';

const srcRoot = resolve(__dirname, '../../../src');

function walk(dir: string, acc: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

function findAliasStrings(source: string): string[] {
  return extractStrings(source)
    .map((s: { value: string }) => s.value)
    .filter((text: string) => text.includes(ALIAS));
}

describe('zh collaboration space naming gate', () => {
  it('no string literal or JSX text under src uses the alias', () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot, [])) {
      const hits = findAliasStrings(readFileSync(file, 'utf8'));
      if (hits.length > 0) offenders.push(`${file.slice(srcRoot.length + 1)}: ${hits[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('flags a synthetic source that mixes both names, ignoring comments', () => {
    const source = [
      `// ${ALIAS} only in a comment`,
      `const a = '升级为${CANONICAL}';`,
      `const b = '请先登录后再使用${ALIAS}。';`,
      `export const C = () => <div>${ALIAS}</div>;`,
    ].join('\n');
    const hits = findAliasStrings(source);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(findAliasStrings(`// ${ALIAS}\nconst a = '${CANONICAL}';`)).toEqual([]);
  });
});
