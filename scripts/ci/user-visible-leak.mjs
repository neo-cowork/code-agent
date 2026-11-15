#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { extractStrings } from '../check-copy.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '../..');
const baselinePath = 'scripts/ci/user-visible-leak-baseline.json';
// A command has a standalone slash, not a path/URL prefix or suffix.
const tokens = /-1743|osascript|apple ?events|\bTCC\b|(?<![a-z0-9_./:@?=&%+-])\/(?:login|model)(?![a-z0-9_/#=&%-]|\.[a-z0-9]|\?[a-z0-9])/giu;
const key = (file, value) => JSON.stringify([file, value]);

function collect(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['tests', '__tests__', 'node_modules', 'dist'].includes(entry.name)) collect(full, files);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)
      && !/\.(test|spec|d)\.tsx?$/.test(entry.name)) files.push(full);
  }
}

function stringsAndAllows(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (ast.parseDiagnostics.length) throw new Error(`Cannot parse ${file}`);
  const masked = source.split('');
  const jsx = [];
  const allows = new Set();
  const comments = (ranges) => {
    for (const range of ranges ?? []) {
      if (/^\/\/\s*leak-allow:\s*\S[^\r\n]*$/.test(source.slice(range.pos, range.end))) {
        allows.add(ast.getLineAndCharacterOfPosition(range.pos).line + 1);
      }
    }
  };
  const mask = (node) => {
    if (!node || !ts.isStringLiteralLike(node)) return;
    for (let i = node.getStart(ast); i < node.end; i++) {
      if (masked[i] !== '\n' && masked[i] !== '\r') masked[i] = ' ';
    }
  };
  const visit = (node) => {
    comments(ts.getLeadingCommentRanges(source, node.pos));
    comments(ts.getTrailingCommentRanges(source, node.end));
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) mask(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) mask(node.argument.literal);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) mask(node.arguments[0]);
    // extractStrings only collects JSX chunks containing CJK. Cover English JSX too.
    if (ts.isJsxText(node) && !/[一-鿿]/.test(node.text)) {
      jsx.push({ value: node.text, line: ast.getLineAndCharacterOfPosition(node.pos).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { strings: [...extractStrings(masked.join('')), ...jsx], allows };
}

export function scan(rootDir) {
  const root = path.resolve(rootDir);
  const baseline = JSON.parse(fs.readFileSync(path.join(root, baselinePath), 'utf8'));
  if (!Array.isArray(baseline) || baseline.some((entry) => typeof entry.file !== 'string' || typeof entry.value !== 'string')) {
    throw new Error('Invalid user-visible-leak baseline');
  }
  const remaining = new Map(baseline.map((entry) => [key(entry.file, entry.value), entry]));
  const files = [];
  for (const rel of ['src/renderer', 'src/shared']) collect(path.join(root, rel), files);
  if (!files.length) throw new Error('Scanned 0 target source files');
  const violations = [];
  let baselineHits = 0;
  for (const full of files.sort()) {
    const file = path.relative(root, full).split(path.sep).join('/');
    const { strings, allows } = stringsAndAllows(fs.readFileSync(full, 'utf8'), file);
    for (const str of strings) {
      const hits = [];
      for (const match of str.value.matchAll(tokens)) {
        const line = str.line + str.value.slice(0, match.index).split('\n').length - 1;
        if (!allows.has(line)) hits.push({ file, line, token: match[0], value: str.value });
      }
      if (!hits.length) continue;
      const id = key(file, str.value);
      if (baseline.some((entry) => key(entry.file, entry.value) === id)) {
        baselineHits++;
        remaining.delete(id);
      } else violations.push(...hits);
    }
  }
  const warnings = [...remaining.values()].map((entry) => `tighten baseline: ${entry.file} ${JSON.stringify(entry.value)}`);
  for (const warning of warnings) console.warn(`[user-visible-leak] warning: ${warning}`);
  return { fileCount: files.length, baselineHits, violations, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const report = scan(process.argv[2] ?? repoRoot);
    for (const hit of report.violations) console.error(`[user-visible-leak] FAIL ${hit.file}:${hit.line} ${hit.token}`);
    if (report.violations.length) process.exitCode = 1;
    else console.log(`[user-visible-leak] PASS scanned ${report.fileCount} files; ${report.baselineHits} baseline hits`);
  } catch (error) {
    console.error(`[user-visible-leak] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
