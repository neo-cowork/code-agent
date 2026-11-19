import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = path.resolve(__dirname, '../../../docs/evidence/N-FIX-BGTASK-CARD-DONE-WITH-FAILED-CONTENT-REST4');

describe('cancelled-closing-line evidence files', () => {
  it('carry no real home-directory paths', () => {
    const text = readdirSync(DIR)
      .filter((name) => /\.(txt|md|json)$/.test(name))
      .map((name) => `${name}\n${readFileSync(path.join(DIR, name), 'utf8')}`)
      .join('\n');
    expect(text).not.toMatch(/\/Users\/[^/\s"\\]+\//);
  });
});
