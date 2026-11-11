#!/usr/bin/env node
// Source checks supplement the real-component census: neither depends on CJK.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tablePath = 'src/renderer/i18n/settingsTerms.json';
const baselinePath = path.join(root, 'scripts/ci/settings-jargon-baseline.json');

export function findSettingsJargon(text, table = JSON.parse(fs.readFileSync(path.join(root, tablePath), 'utf8'))) {
  // Verbatim literals (a header name, a shell command) are blanked in place so indexes stay valid.
  for (const literal of table.literals ?? []) text = text.split(literal).join(' '.repeat(literal.length));
  return table.terms.flatMap((term) => {
    const body = term.term.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]*');
    const re = new RegExp(`(?<![A-Za-z])${body}s?(?![A-Za-z])`, 'gi');
    return Array.from(text.matchAll(re), (match) => ({ term: term.term, human: term.human, mode: term.mode, index: match.index }));
  });
}

export function compareSettingsJargon(rows, baseline) {
  const failures = [];
  for (const entry of baseline) {
    if (!/^N-[A-Z0-9-]+: .+/.test(entry.reason ?? '') || !Number.isInteger(entry.count) || entry.count < 1) {
      failures.push(`Invalid stock entry: ${entry.surface} / ${entry.term} (requires owning ticket and positive count)`);
    }
  }
  for (const row of rows) {
    for (const term of new Set(row.hits.filter((hit) => hit.mode === 'enforce').map((hit) => hit.term))) {
      const hits = row.hits.filter((hit) => hit.term === term && hit.mode === 'enforce');
      const entry = baseline.find((base) => base.surface === row.surface && base.term === term);
      // Models and wizard can never acquire stock exceptions.
      const strict = /^(models\/|wizard\/|settings\/model$)/.test(row.surface);
      const limit = strict ? 0 : entry?.count ?? 0;
      if (hits.length > limit) failures.push(`${row.surface}: ${term} ${hits.length} > baseline ${limit}; use ${hits[0].human}`);
    }
  }
  return failures;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

export function scanSettingsJargon(repoRoot = root) {
  const table = JSON.parse(fs.readFileSync(path.join(repoRoot, tablePath), 'utf8'));
  const files = [
    ...walk(path.join(repoRoot, 'src/renderer/i18n')).filter((file) => /^zhSettings.*\.ts$|^onboarding\.ts$/.test(path.basename(file))),
    ...walk(path.join(repoRoot, 'src/renderer/components/features/settings')).filter((file) => file.endsWith('.tsx')),
    ...walk(path.join(repoRoot, 'src/renderer/components/onboarding')).filter((file) => file.endsWith('.tsx')),
  ];
  if (!files.length) throw new Error('Settings scan found no files');
  const rows = [];
  for (const file of files) {
    const locale = file.split(path.sep).join('/').includes('/i18n/');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const hits = [];
    function visit(node) {
      // This mixed file contains both languages; the English bundle is unchanged.
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'onboardingEn') return;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      const jsxText = ts.isJsxText(node);
      const literal = ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
      const attribute = node.parent && ts.isJsxAttribute(node.parent) && ['title', 'placeholder', 'aria-label'].includes(node.parent.name.getText(source));
      const expression = node.parent && ts.isJsxExpression(node.parent);
      const propertyName = node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node;
      if (jsxText || (literal && !propertyName && (locale || attribute || expression))) {
        const text = locale ? node.text.replace(/\{[a-z]\w*\}/g, (placeholder) => ' '.repeat(placeholder.length)) : node.text;
        for (const hit of findSettingsJargon(text, table)) hits.push({ ...hit, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    rows.push({ surface: path.relative(repoRoot, file).split(path.sep).join('/'), hits });
  }
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const censusArg = process.argv.indexOf('--census');
  const rows = censusArg < 0 ? scanSettingsJargon() : JSON.parse(fs.readFileSync(process.argv[censusArg + 1], 'utf8')).map((row) => {
    const text = row.text + '\n' + (row.attributes ?? []).map((attribute) => attribute.text).join('\n');
    return { surface: row.surface, hits: findSettingsJargon(text) };
  });
  const failures = compareSettingsJargon(rows, censusArg < 0 ? baseline.source : baseline.browser);
  for (const row of rows) {
    const report = row.hits.filter((hit) => hit.mode === 'report').length;
    if (report) console.log(`[settings-jargon] report-only ${row.surface}: MCP ${report}`);
  }
  for (const failure of failures) console.error(`[settings-jargon] FAIL ${failure}`);
  console.log(`[settings-jargon] ${failures.length ? 'FAIL' : 'PASS'} ${rows.length} surfaces; ${failures.length} unexplained hits`);
  if (failures.length) process.exitCode = 1;
}
