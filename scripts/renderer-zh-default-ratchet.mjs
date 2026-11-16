#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..');
const DEFAULT_BASELINE = 'scripts/renderer-zh-default-baseline.json';

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function collectFiles(rootDir) {
  const root = path.join(rootDir, 'src/renderer');
  if (!fs.existsSync(root)) throw new Error(`Missing scan root: ${root}`);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['i18n', '__tests__', 'node_modules'].includes(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files.sort();
}

function isZhPackReference(node) {
  return ts.isIdentifier(node) && /^ZH_[A-Z0-9_]+$/.test(node.text);
}

function isZhPropertyAccess(node) {
  return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'zh';
}

function scanFile(rootDir, absPath) {
  const rel = toPosix(path.relative(rootDir, absPath));
  const source = fs.readFileSync(absPath, 'utf8');
  const sourceFile = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true, absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (sourceFile.parseDiagnostics.length > 0) throw new Error(`TypeScript parse failed: ${rel}`);
  const findings = [];
  const add = (node, kind) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({ file: rel, line: line + 1, column: character + 1, kind, preview: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 160) });
  };
  const visit = (node) => {
    if ((ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer) {
      if (ts.isIdentifier(node.name) && /^(?:lang|language|locale)$/.test(node.name.text)
        && ts.isStringLiteral(node.initializer) && node.initializer.text === 'zh') {
        add(node, 'zh-language-default');
      }
      if (isZhPackReference(node.initializer)) add(node, 'zh-pack-default');
    }
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer && isZhPackReference(node.initializer)) {
      add(node, 'zh-pack-default');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      if (isZhPropertyAccess(node.right)) add(node, 'zh-nullish-fallback');
      if (isZhPackReference(node.right)) add(node, 'zh-pack-nullish-fallback');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function scanAll(repoRoot) {
  const files = collectFiles(repoRoot);
  if (files.length === 0) throw new Error('No renderer source files scanned');
  const findings = files.flatMap((file) => scanFile(repoRoot, file));
  const byFile = new Map();
  for (const finding of findings) {
    const entry = byFile.get(finding.file) ?? { count: 0, kinds: {} };
    entry.count += 1;
    entry.kinds[finding.kind] = (entry.kinds[finding.kind] ?? 0) + 1;
    byFile.set(finding.file, entry);
  }
  return { scanned: files.length, findings, byFile };
}

function readBaseline(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing baseline: ${file}`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.schemaVersion !== 1 || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    throw new Error(`Invalid baseline: ${file}`);
  }
  return parsed;
}

function currentEntries(report) {
  return Object.fromEntries([...report.byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, entry]) => [file, {
    count: entry.count,
    kinds: Object.fromEntries(Object.entries(entry.kinds).sort(([a], [b]) => a.localeCompare(b))),
  }]));
}

function checkCommittedBaseline(repoRoot, baselinePath, baseline) {
  const top = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) return;
  const rel = toPosix(path.relative(top.stdout.trim(), baselinePath));
  const shown = spawnSync('git', ['-C', repoRoot, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (shown.status !== 0) return;
  const committed = JSON.parse(shown.stdout);
  for (const [file, entry] of Object.entries(baseline.files)) {
    const previous = committed.files?.[file]?.count ?? 0;
    if (entry.count > previous) throw new Error(`Baseline increased for ${file}: committed=${previous} working=${entry.count}`);
  }
}

function parseArgs(argv) {
  const args = { repoRoot: defaultRepoRoot, baseline: null, update: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--update-baseline') args.update = true;
    else if (argv[i] === '--repo-root') args.repoRoot = path.resolve(argv[++i]);
    else if (argv[i] === '--baseline') args.baseline = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  args.baseline ??= path.join(args.repoRoot, DEFAULT_BASELINE);
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = scanAll(args.repoRoot);
  const baseline = readBaseline(args.baseline);
  const current = currentEntries(report);
  const files = [...new Set([...Object.keys(baseline.files), ...Object.keys(current)])].sort();
  const regressions = [];
  const lowered = [];
  for (const file of files) {
    const now = current[file]?.count ?? 0;
    const before = baseline.files[file]?.count ?? 0;
    if (now > before) regressions.push({ file, now, before });
    if (now < before) lowered.push({ file, now, before });
  }
  console.log(`[renderer-zh-default-ratchet] scanned=${report.scanned} files=${Object.keys(current).length} targets=${report.findings.length} baseline=${Object.values(baseline.files).reduce((sum, entry) => sum + entry.count, 0)}`);
  for (const finding of report.findings) {
    console.log(`[renderer-zh-default-ratchet] ${finding.file}:${finding.line}:${finding.column} [${finding.kind}] ${finding.preview}`);
  }
  if (regressions.length > 0) {
    throw new Error(`New default-to-zh fallback detected: ${regressions.map((entry) => `${entry.file} current=${entry.now} baseline=${entry.before}`).join(', ')}`);
  }
  checkCommittedBaseline(args.repoRoot, args.baseline, baseline);
  if (args.update) {
    if (regressions.length > 0) throw new Error('Cannot raise the zh-default baseline');
    fs.writeFileSync(args.baseline, `${JSON.stringify({ schemaVersion: 1, files: current }, null, 2)}\n`);
    console.log(`[renderer-zh-default-ratchet] baseline lowered: files=${lowered.length}`);
    return;
  }
  if (lowered.length > 0) {
    throw new Error(`Baseline is stale; run --update-baseline: ${lowered.map((entry) => `${entry.file} current=${entry.now} baseline=${entry.before}`).join(', ')}`);
  }
  console.log('[renderer-zh-default-ratchet] ✓ equals baseline; no new default-to-zh fallback');
}

try {
  main();
} catch (error) {
  console.error(`[renderer-zh-default-ratchet] ✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
