#!/usr/bin/env node
// Date-locale ratchet. AST heuristic, not type checking: all toLocaleDateString /
// toLocaleTimeString calls; toLocaleString on new Date(), date/d/*At identifiers
// or properties, Date-annotated bindings, and bindings initialized with new Date().
// Parentheses/casts and static bracket method names are unwrapped. Aliases returned
// by arbitrary functions, dynamic method names and cross-file types are not inferred.
// Numeric toLocaleString calls are deliberately outside this gate.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const root = path.resolve(option('root', 'src/renderer'));
const allowlistPath = option('allowlist', 'scripts/ci/renderer-date-locales-allowlist.json');
// Only shrink: changing this cap to admit new exceptions weakens the ratchet.
const BASELINE = 21;
const errors = [];
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
const keys = new Set();
let count = 0;
for (const entry of allowlist) {
  if (typeof entry.reason !== 'string' || !entry.reason.trim() || /[\r\n]/u.test(entry.reason)) {
    errors.push(`allowlist entry needs a one-line reason: ${entry.file ?? '?'}`);
  }
  if (typeof entry.file !== 'string' || typeof entry.call !== 'string'
      || !Number.isInteger(entry.count) || entry.count < 1) {
    errors.push('invalid allowlist entry');
  }
  const key = `${entry.file}:${entry.call}`;
  if (keys.has(key)) errors.push(`duplicate allowlist entry: ${entry.file}`);
  keys.add(key);
  count += entry.count;
}
if (count > BASELINE) errors.push(`allowlist count ${count} exceeds baseline ${BASELINE}`);

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : files(file);
    return /\.[cm]?[jt]sx?$/u.test(file) && !/\.(test|spec)\./u.test(file) ? [file] : [];
  });
}
function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}
function isNewDate(node) {
  node = unwrap(node);
  return ts.isNewExpression(node) && node.expression.getText() === 'Date';
}
const hits = [];
for (const file of files(root)) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const dateBindings = new Set();
  const collectBindings = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)
      && ((node.initializer && isNewDate(node.initializer)) || node.type?.getText(source) === 'Date')) {
      dateBindings.add(node.name.text);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(source);
  const isDateReceiver = (node) => {
    node = unwrap(node);
    if (isNewDate(node)) return true;
    const name = ts.isIdentifier(node) ? node.text
      : ts.isPropertyAccessExpression(node) ? node.name.text : '';
    return /^(?:date|d)$/iu.test(name) || /At$/u.test(name) || dateBindings.has(name);
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
          ? callee.argumentExpression.text : '';
      if (/^toLocale(?:Date|Time)String$/u.test(method)
        || (method === 'toLocaleString' && isDateReceiver(callee.expression))) {
        hits.push({
          file: path.relative(root, file).split(path.sep).join('/'),
          call: node.getText(source).replace(/\s+/gu, ' '),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const used = new Map();
for (const hit of hits) {
  const entry = allowlist.find((item) => item.file === hit.file && item.call === hit.call);
  const key = `${hit.file}:${hit.call}`;
  const n = (used.get(key) ?? 0) + 1;
  used.set(key, n);
  if (!entry || n > entry.count) errors.push(`${hit.file}:${hit.line}: bare Date locale call: ${hit.call}`);
}
for (const entry of allowlist) {
  if ((used.get(`${entry.file}:${entry.call}`) ?? 0) !== entry.count) {
    errors.push(`stale allowlist entry (remove or shrink): ${entry.file}: ${entry.call}`);
  }
}
if (errors.length) {
  for (const error of errors) console.error(`FAIL ${error}`);
  process.exitCode = 1;
} else console.log(`PASS renderer date locales: ${hits.length} reasoned date/time-only sites <= baseline ${BASELINE}`);
