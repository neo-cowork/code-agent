import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve('src/renderer');
const NATIVE_RECEIVERS = new Set(['window', 'globalThis', 'self']);

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return /^(?:__tests__|__mocks__)$/.test(entry.name) ? [] : sources(file);
    return /\.tsx?$/.test(file) && !/\.(?:test|spec)\.tsx?$/.test(file) ? [file] : [];
  });
}

function declaresConfirm(node: ts.Node): boolean {
  if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
    || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)
    || ts.isImportEqualsDeclaration(node) || ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
    return node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === 'confirm';
  }
  return false;
}

function nativeCalls(source: string, filename = 'input.tsx'): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const bare: ts.CallExpression[] = [];
  const qualified: ts.CallExpression[] = [];
  let hasLocalConfirm = false;

  function visit(node: ts.Node) {
    if (declaresConfirm(node)) hasLocalConfirm = true;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'confirm') bare.push(node);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const receiver = callee.expression;
        const key = ts.isPropertyAccessExpression(callee) ? callee.name : callee.argumentExpression;
        if (ts.isIdentifier(receiver) && NATIVE_RECEIVERS.has(receiver.text)
          && (ts.isPropertyAccessExpression(callee) ? ts.isIdentifier(key) : ts.isStringLiteralLike(key))
          && key.text === 'confirm') {
          qualified.push(node);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return (hasLocalConfirm ? qualified : [...qualified, ...bare]).map((call) => {
    const { line, character } = file.getLineAndCharacterOfPosition(call.getStart(file));
    return `${line + 1}:${character + 1}: native ${call.expression.getText(file)}; use requestConfirm`;
  });
}

describe('renderer native confirm gate', () => {
  it('routes confirmation through the in-app dialog', () => {
    const violations = sources(ROOT).flatMap((file) =>
      nativeCalls(readFileSync(file, 'utf8'), file).map((call) => `${path.relative(ROOT, file)}:${call}`),
    );
    expect(violations).toEqual([]);
  });

  it.each([
    'window.confirm("Continue?")',
    'globalThis.confirm("Continue?")',
    'self.confirm("Continue?")',
    "window['confirm']('Continue?')",
    "globalThis['confirm']('Continue?')",
    "self['confirm']('Continue?')",
    'confirm("Continue?")',
  ])('rejects %s', (source) => {
    expect(nativeCalls(source)).toHaveLength(1);
  });

  it('allows a local callback', () => {
    expect(nativeCalls('const confirm = () => true; confirm();')).toEqual([]);
  });

  it('rejects a native call even when a local callback exists', () => {
    expect(nativeCalls("const confirm = () => true; confirm(); window['confirm']('Continue?');")).toHaveLength(1);
  });
});
