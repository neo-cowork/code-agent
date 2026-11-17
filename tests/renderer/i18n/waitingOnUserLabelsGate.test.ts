import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// 静态闸：「等你处理」状态标签只能从 src/shared/i18n/waitingOnUserLabels.ts 取，
// 其余位置出现旧变体字面量即红，报 file:line。
const ROOT = join(__dirname, '..', '..', '..');
const SCAN_DIRS = ['src/renderer', 'src/shared'];
const ALLOWED = 'src/shared/i18n/waitingOnUserLabels.ts';
const BANNED = [
  '等你批准',
  'Waiting for your approval',
  'Waiting for you to confirm',
  'Waiting for your confirmation',
];

function scanText(text: string, file: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const literal of BANNED) {
      if (line.includes(literal)) hits.push(`${file}:${i + 1} 含已禁用文案「${literal}」`);
    }
  });
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
}

describe('waiting-on-user label gate', () => {
  it('src/renderer 与 src/shared 不得再写旧的等待标签字面量', () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
    const hits = files
      .map((f) => relative(ROOT, f).split(sep).join('/'))
      .filter((f) => f !== ALLOWED)
      .flatMap((f) => scanText(readFileSync(join(ROOT, f), 'utf-8'), f));
    expect(hits).toEqual([]);
  });

  it('反向：含禁用字面量的夹具必须被同一扫描器命中', () => {
    const fixture = ["const a = 1;", "const label = '等你批准';", "const en = 'Waiting for your approval';"].join('\n');
    const hits = scanText(fixture, 'fixture.ts');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toContain('fixture.ts:2');
  });
});
