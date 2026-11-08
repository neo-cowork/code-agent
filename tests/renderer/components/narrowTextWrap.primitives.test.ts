import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('narrow text wrapping primitives', () => {
  it('keeps Badge and Button base classes on one line', () => {
    const badge = readFileSync(resolve(process.cwd(), 'src/renderer/components/primitives/Badge.tsx'), 'utf8');
    const button = readFileSync(resolve(process.cwd(), 'src/renderer/components/primitives/Button.tsx'), 'utf8');

    expect(badge).toMatch(/className=\{`inline-flex shrink-0 items-center gap-1 rounded border px-1\.5 py-0\.5 whitespace-nowrap \$\{className\}`\}/);
    expect(button).toMatch(/inline-flex shrink-0 items-center justify-center whitespace-nowrap/);
  });
});
