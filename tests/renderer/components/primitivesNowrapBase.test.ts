import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('primitives carry nowrap in their base class', () => {
  it('Badge base class has whitespace-nowrap and shrink-0', () => {
    const src = read('src/renderer/components/primitives/Badge.tsx');
    const base = /<span className=\{`([^`]*)\$\{className\}`\}/.exec(src)?.[1] ?? '';
    expect(base).toContain('inline-flex');
    expect(base.split(/\s+/)).toContain('whitespace-nowrap');
    expect(base.split(/\s+/)).toContain('shrink-0');
  });

  it('Button baseStyles has whitespace-nowrap and shrink-0', () => {
    const src = read('src/renderer/components/primitives/Button.tsx');
    const block = /const baseStyles = \[([\s\S]*?)\]\.join/.exec(src)?.[1] ?? '';
    expect(block).toContain('whitespace-nowrap');
    expect(block).toContain('shrink-0');
  });

  it('Button keeps a child icon on the label row', () => {
    const src = read('src/renderer/components/primitives/Button.tsx');
    expect(src).toMatch(/\{children && <span className="inline-flex items-center gap-1\.5">\{children\}<\/span>\}/);
  });
});
