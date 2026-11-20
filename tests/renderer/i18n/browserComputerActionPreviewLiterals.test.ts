// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { getBrowserComputerActionPreviewMessages } from '../../../src/renderer/i18n/browserComputerActionPreview';

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

// 中文文案里有意保留的英文词（secretRef 为参数名；SAMPLE/click 是测试喂入的占位参数回显）。新增英文词必须先登记到这里。
const RETAINED_LATIN_TERMS = new Set<string>(['secretRef', 'SAMPLE', 'click']);

describe('browser/computer action preview zh copy keeps no stray English', () => {
  it('only registered Latin terms appear in zh messages', () => {
    const messages = getBrowserComputerActionPreviewMessages('zh') as Record<string, unknown>;
    const found = new Set<string>();
    for (const value of Object.values(messages)) {
      const text = typeof value === 'function'
        ? String((value as (...a: unknown[]) => unknown)('click', 'SAMPLE'))
        : String(value);
      for (const word of text.match(/[A-Za-z][A-Za-z]+/g) ?? []) found.add(word);
    }
    const unregistered = [...found].filter(word => !RETAINED_LATIN_TERMS.has(word));
    expect(unregistered).toEqual([]);
  });
});
