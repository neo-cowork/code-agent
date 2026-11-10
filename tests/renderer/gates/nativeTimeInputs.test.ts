import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Native time controls follow the OS locale. Exceptions require a specific source
// occurrence and an explanation; none are currently needed.
const ALLOWLIST: { file: string; source: string; reason: string }[] = [];
const ROOT = path.resolve('src/renderer');

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return /^(?:__tests__|__mocks__)$/.test(entry.name) ? [] : sources(file);
    return /\.tsx?$/.test(file) && !/\.(?:test|spec)\.tsx?$/.test(file) ? [file] : [];
  });
}

function forbiddenLiterals(source: string): string[] {
  const file = ts.createSourceFile('input.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) && (node.text === 'time' || node.text === 'datetime-local')) {
      const parent = node.parent;
      // These are data field names, not input type values (telemetry/template keys).
      const dataKey = node.text === 'time' && (
        (ts.isPropertyAssignment(parent) && parent.name.getText(file) === 'key' && parent.initializer === node)
        || (ts.isLiteralTypeNode(parent) && ts.isIndexedAccessTypeNode(parent.parent))
        || (ts.isPropertyAssignment(parent) && parent.name === node)
      );
      if (!dataKey) found.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

describe('renderer native time input gate', () => {
  it('has no native time type literals, including consts, expressions and type unions', () => {
    for (const entry of ALLOWLIST) expect(entry.reason.trim().length).toBeGreaterThan(0);
    const violations = sources(ROOT).flatMap((file) => {
      const relative = path.relative(ROOT, file);
      return forbiddenLiterals(readFileSync(file, 'utf8'))
        .filter((source) => !ALLOWLIST.some((entry) => entry.file === relative && entry.source === source))
        .map((source) => `${relative}: forbidden native input type ${source}; use TimeInput24 / DateTimeInput24`);
    });
    expect(violations).toEqual([]);
  });

  it.each([
    '<input type="time" />',
    "<Input type={'time'} />",
    "<Input type={kind === 'datetime' ? 'datetime-local' : 'text'} />",
    "const nativeType = 'datetime-local'; <input type={nativeType} />",
    'const nativeType = `time`; <input type={nativeType} />',
    "const props = { type: 'time' }; <input {...props} />",
    "type InputType = 'text' | 'time' | 'datetime-local';",
  ])('rejects %s', (source) => {
    expect(forbiddenLiterals(source).length).toBeGreaterThan(0);
  });

  it('ignores comments and data keys', () => {
    expect(forbiddenLiterals("// datetime-local\nconst field = { key: 'time' }; type T = Data['time'];")).toEqual([]);
  });
});
