#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const repoIndex = args.indexOf('--repo-root');
const repoRoot = path.resolve(repoIndex >= 0 ? args[repoIndex + 1] : path.join(scriptDir, '..'));

function sourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [file] : [];
  });
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function pairProperty(node) {
  if (!ts.isPropertyAssignment(node) || !ts.isStringLiteral(node.initializer)) return null;
  const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
  if (name !== 'one' && name !== 'other') return null;
  const parent = node.parent;
  if (!ts.isObjectLiteralExpression(parent)) return null;
  const keys = new Set(parent.properties.filter(ts.isPropertyAssignment).map((property) => {
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
    return '';
  }));
  return keys.has('one') && keys.has('other') ? name : null;
}

const i18nRoot = path.join(repoRoot, 'src/renderer/i18n');
const files = sourceFiles(i18nRoot);
const findings = [];
const hardPlural = /\{(?:count|n)\}\s+(?:agents|segments)\b/i;

for (const file of files) {
  const sourceText = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const value = node.text;
      const point = `${path.relative(repoRoot, file).split(path.sep).join('/')}:${lineOf(sourceFile, node)}`;
      if (/\b[A-Za-z]+\(s\)/.test(value)) {
        findings.push(`${point} contains forbidden literal "(s)": ${value}`);
      }
      const match = value.match(hardPlural);
      if (match && pairProperty(node.parent) !== 'other') {
        findings.push(`${point} uses hard plural after a count placeholder: ${value}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

// Component copy must use the shared translations too. Match syntax nodes rather
// than source lines so multiline JSX/templates are checked and comments are not.
const componentFiles = sourceFiles(path.join(repoRoot, 'src/renderer/components'))
  .filter((file) => file.endsWith('.tsx'));
// Existing exceptions only: each entry needs { file, text, reason }. Remove an
// entry when fixed; do not add new leaks. No exceptions remain at introduction.
const inlineCountAllowlist = [];
const usedExceptions = new Set();
let inlineCountHits = 0;
for (const file of componentFiles) {
  const sourceText = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');
  const report = (node) => {
    inlineCountHits++;
    const text = node.getText(sourceFile);
    const exception = inlineCountAllowlist.find((entry) => entry.file === relative && entry.text === text && entry.reason);
    if (exception) {
      usedExceptions.add(exception);
    } else {
      findings.push(`${relative}:${lineOf(sourceFile, node)} rendered inline count must use i18n: ${text}`);
    }
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const siblings = node.parent.children;
      const index = siblings.indexOf(node);
      const previous = siblings[index - 1];
      const next = siblings[index + 1];
      // {count} lines, including the old line{count > 1 ? 's' : ''}.
      const afterCount = previous && ts.isJsxExpression(previous) && /^\s*lines?\b/.test(node.text);
      const suffix = next && ts.isJsxExpression(next) && next.expression;
      const inlineSuffix = /\bline$/.test(node.text.trimEnd()) && suffix && ts.isConditionalExpression(suffix)
        && [suffix.whenTrue, suffix.whenFalse].some((branch) => ts.isStringLiteral(branch) && branch.text === 's');
      if (afterCount || inlineSuffix) report(node);
    } else if (ts.isTemplateSpan(node) && /^\s+lines?\b/.test(node.literal.text)) {
      // `${count} lines`, including a template returned from a render helper.
      report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}
for (const entry of inlineCountAllowlist) {
  if (!usedExceptions.has(entry)) findings.push(`stale inline count exception: ${entry.file} (${entry.reason})`);
}
console.log(`[i18n-plural-ratchet] scanned ${componentFiles.length} renderer components; inline count hits=${inlineCountHits}; allowed=${usedExceptions.size}`);

if (findings.length > 0) {
  console.error(`[i18n-plural-ratchet] ✗ found ${findings.length} invalid English count phrase(s)`);
  for (const finding of findings) console.error(`[i18n-plural-ratchet] ${finding}`);
  process.exit(1);
}

console.log(`[i18n-plural-ratchet] ✓ scanned ${files.length} renderer i18n source files; no forbidden count phrases`);
