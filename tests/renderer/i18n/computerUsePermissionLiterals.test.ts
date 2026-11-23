// @vitest-environment node
// N-FIX-CU-PAGE-PERMISSION-LABELS-NOT-LOCALIZED：Computer Use 页源码里不得再出现硬编码的
// 权限名（Accessibility / Screen Recording / Automation）或 必需/可选 徽章字面量——
// 它们只能来自 src/renderer/i18n/localOps.ts。走 AST 收集字符串/模板/JSX 文本
// （覆盖函数返回值），注释天然不是节点、不会被算进来。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SCANNED_FILES = [
  'src/renderer/components/features/computerUse/ComputerUseContent.tsx',
  'src/renderer/utils/computerUseWorkbench.ts',
] as const;

const BANNED: Array<[RegExp, string]> = [
  [/\bAccessibility\b/, 'Accessibility'],
  [/\bScreen Recording\b/, 'Screen Recording'],
  [/\bAutomation\b/, 'Automation'],
  [/必需/, '必需'],
  [/可选/, '可选'],
];

/** 收集源码里所有会变成用户可见文本的字面量：字符串、模板静态段、JSX 文本。 */
function collectLiterals(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text);
      for (const span of node.templateSpans) out.push(span.literal.text);
    } else if (ts.isJsxText(node)) {
      out.push(node.getText(sourceFile));
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return out;
}

describe('Computer Use 页权限文案字面量扫描', () => {
  it.each(SCANNED_FILES)('%s 不含硬编码权限名/必需/可选（注释除外）', (relPath) => {
    const source = readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    const literals = collectLiterals(source, relPath);
    expect(literals.length, `${relPath} 至少应扫到字符串/JSX 文本`).toBeGreaterThan(0);
    for (const [pattern, label] of BANNED) {
      const hit = literals.find((text) => pattern.test(text));
      expect(hit, `${relPath} 不应再出现硬编码「${label}」（应走 localOps.computerUse 文案），命中: ${hit}`)
        .toBeUndefined();
    }
  });

  it('扫描器自身有效：能命中字符串/模板/JSX 文本里的字面量，忽略注释', () => {
    const sample = [
      '// Accessibility 注释 必需',
      '/* Screen Recording 块注释 可选 */',
      'const name = "Accessibility";',
      'const title = `${label} 可选`;',
      'const View = () => (<span>Screen Recording</span>);',
      "const url = 'http://x//y';",
    ].join('\n');
    const literals = collectLiterals(sample, 'sample.tsx');
    expect(literals).toContain('Accessibility');
    expect(literals).toContain(' 可选');
    expect(literals).toContain('Screen Recording');
    expect(literals).toContain('http://x//y');
    expect(literals.join(' ')).not.toContain('注释');
  });
});
