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

function propertyName(node) {
  if (!node || !ts.isPropertyAssignment(node)) return null;
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
}

const i18nRoot = path.join(repoRoot, 'src/renderer/i18n');
const files = sourceFiles(i18nRoot);
const findings = [];
const pluralFindings = [];

// English count nouns that must never follow a {count}/{n} placeholder in a bare
// string: a hard plural ("{count} steps") breaks at count 1. Every hit has to be
// the `other` branch of a { one, other } pair (interpolatePlural picks the branch),
// so the singular branch exists and count 1 reads grammatically.
// Up to two connector words may sit between placeholder and noun ("{count} more
// files not shown", "About {count} sub-agent calls").
const NOUNS = [
  'agents', 'segments',
  'steps', 'files', 'times', 'items', 'tasks', 'messages', 'commands', 'results',
  'tools', 'matches', 'lines', 'pages', 'minutes', 'hours', 'days', 'errors',
  'skills', 'memories', 'connectors', 'sessions', 'attachments', 'changes',
  'events', 'runs', 'rows', 'tokens', 'seconds',
  'approvals', 'artifacts', 'assets', 'attributions', 'calls', 'candidates',
  'characters', 'checks', 'compactions', 'connections', 'conversations',
  'deliveries', 'entries', 'findings', 'goals', 'hits', 'images', 'instructions',
  'iterations', 'issues', 'lookups', 'members', 'models', 'numbers', 'ops',
  'outputs', 'paths', 'pieces', 'recipients', 'recordings', 'regions', 'rules',
  'scripts', 'sites', 'slides', 'sources', 'spots', 'subtasks', 'tabs', 'turns', 'classes', 'scopes', 'orderings',
].join('|');
const hardPlural = new RegExp(`\\{(?:count|n)\\}(?:\\s+[A-Za-z][A-Za-z/-]*){0,2}\\s+(?:${NOUNS})\\b`, 'i');
// zh copy has no plural grammar and intentionally embeds English loanwords
// ("节省 {count} tokens"); the ratchet flags invalid English count phrases only.
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

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
      if (match && pairProperty(node.parent) !== 'other' && !CJK.test(value)) {
        // `group` tables (toolStepVerbs.ts / chatTranscript.ts toolStepHumanize) are
        // exempt: they only render for count !== 1 — the singular branch is the
        // groupSingular table, pinned by tests/renderer/i18n/enCountPlural.test.ts.
        // The table is two levels up: group: { explored: '...' }.
        const groupOwner = ts.isObjectLiteralExpression(node.parent?.parent) ? node.parent.parent.parent : undefined;
        if (propertyName(node.parent) !== 'group' && propertyName(groupOwner) !== 'group') {
          pluralFindings.push(`${point} uses hard plural after a count placeholder: ${value}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

// Baseline: strings the gate newly flags outside the converted files. May shrink,
// may not grow — fix a string and delete (or lower) its entry; never raise one.
const baselinePath = path.join(repoRoot, 'scripts', 'i18n-plural-baseline.json');
const baseline = fs.existsSync(baselinePath)
  ? JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  : {};
const perFile = new Map();
for (const finding of pluralFindings) {
  const file = finding.split(':')[0];
  perFile.set(file, (perFile.get(file) ?? 0) + 1);
}
let remaining = 0;
for (const [file, count] of perFile) {
  const allowed = baseline[file];
  if (allowed === undefined) {
    findings.push(`${file}: ${count} hard plural(s) not in baseline — convert to a { one, other } pair or add to scripts/i18n-plural-baseline.json (files outside the converted set only)`);
    for (const finding of pluralFindings) {
      if (finding.startsWith(`${file}:`)) findings.push(finding);
    }
  } else if (count > allowed) {
    findings.push(`${file}: ${count} hard plural(s) exceed baseline ${allowed} — baseline may shrink, may not grow`);
    for (const finding of pluralFindings) {
      if (finding.startsWith(`${file}:`)) findings.push(finding);
    }
  }
  remaining += count;
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

console.log(`[i18n-plural-ratchet] ✓ scanned ${files.length} renderer i18n source files; no unbaselined count phrases; baseline remaining=${remaining} across ${perFile.size} file(s) (may shrink, may not grow)`);
