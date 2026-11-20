// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const files = [
  'browserComputerActionPreview.ts',
  'browserComputerExportRedaction.ts',
  'agentPointer.ts',
];

describe('browser/computer action preview localization', () => {
  it.each(files)('%s has no Han characters in string literals or template text', (file) => {
    const url = new URL(`../../../src/renderer/utils/${file}`, import.meta.url);
    const source = ts.createSourceFile(file, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true);
    const violations: string[] = [];
    function visit(node: ts.Node): void {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
          || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
        && /\p{Script=Han}/u.test(node.text)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${file}:${line + 1}: ${node.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    }

    ts.forEachChild(source, visit);
    expect(violations).toEqual([]);
  });
});
