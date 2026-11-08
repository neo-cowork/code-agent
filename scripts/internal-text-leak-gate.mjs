#!/usr/bin/env node
/**
 * N-UX-INTERNAL-TEXT-LEAK-SYSTEMIC-CORE — Internal Text Leak Gate
 *
 * Scans user-visible renderer surfaces for the 9 internal format categories:
 *   1. uuid               ([0-9a-f]{8}-[0-9a-f]{4}-...)
 *   2. session_id         (session_..., session-work-...)
 *   3. call_id            (call_..., toolu_...)
 *   4. ou_id              (ou_..., oc_...)
 *   5. internal_tool_name (read_file, write_file, mcp__..., etc.)
 *   6. english_state_word (accepted：..., [running] id=, interrupted: process crashed, etc.)
 *   7. sandbox_exec       (sandbox-exec -f ...)
 *   8. temp_path          (/tmp/..., /private/tmp/..., /var/folders/...)
 *   9. raw_json           ({"key": ...})
 *
 * Combines:
 *   (a) Static TypeScript AST scan over src/renderer (JSX text, JSX expressions,
 *       user-facing JSX attributes, toast/notification arguments, and i18n catalogs).
 *   (b) Dynamic render scan over the 4 key surfaces (via vitest on
 *       tests/renderer/components/internalTextLeakDynamicScan.test.tsx unless --static-only).
 *
 * Fails loud on:
 *   - 0 scanned files
 *   - TypeScript parse errors
 *   - Missing/corrupt allowlist JSON or any allowlist entry without a non-empty `reason`
 *   - Any un-allowlisted leak hit
 *
 * Allowlist entries that no longer match only emit a warning so sibling fix PRs can land
 * without breaking on a shrinking allowlist.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_RENDERER_DIR = path.join(REPO_ROOT, 'src/renderer');
const DEFAULT_ALLOWLIST_PATH = path.join(
  REPO_ROOT,
  'scripts/internal-text-leak-allowlist.json',
);
const DEFAULT_DYNAMIC_ALLOWLIST_PATH = path.join(
  REPO_ROOT,
  'scripts/internal-text-leak-dynamic-allowlist.json',
);
const SHARED_PATTERNS = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, 'src/shared/internalTextLeakPatterns.json'),
    'utf8',
  ),
);

const VALID_RULES = new Set([
  'uuid',
  'session_id',
  'call_id',
  'ou_id',
  'internal_tool_name',
  'english_state_word',
  'sandbox_exec',
  'temp_path',
  'raw_json',
]);

const USER_FACING_JSX_ATTRS = new Set([
  'title',
  'aria-label',
  'placeholder',
  'label',
  'alt',
  'description',
  'subtitle',
  'emptyText',
  'helperText',
  'value',
]);

const INTERNAL_TOOL_NAMES = [...SHARED_PATTERNS.internalToolNames].sort(
  (a, b) => b.length - a.length,
);

const UUID_RE = new RegExp(SHARED_PATTERNS.uuid, 'i');
const SESSION_ID_RE = new RegExp(SHARED_PATTERNS.sessionId);
const SESSION_PREFIX_RE = /^(?:session_|session-work-)$/;
const CALL_ID_RE = new RegExp(SHARED_PATTERNS.callId);
const CALL_PREFIX_RE = /^(?:call_|toolu_)$/;
const OU_ID_RE = new RegExp(SHARED_PATTERNS.ouId);
const OU_PREFIX_RE = /^(?:ou_|oc_)$/;
const INTERNAL_TOOL_RE = new RegExp(
  `(?:${SHARED_PATTERNS.internalToolPrefix}|(?<![A-Za-z0-9_/-])(?:${INTERNAL_TOOL_NAMES.join('|')}))(?![A-Za-z0-9_/-])`,
);
const ENGLISH_STATE_RES = SHARED_PATTERNS.englishState.map((source) => new RegExp(source, 'i'));
const SANDBOX_EXEC_RE = new RegExp(SHARED_PATTERNS.sandboxExec);
const TEMP_PATH_RE = new RegExp(SHARED_PATTERNS.tempPath);
const RAW_JSON_RE =
  new RegExp(
    `^\\s*\\{(?:\\s*${SHARED_PATTERNS.rawJsonKeyValue}\\s*,?){1,}\\}\\s*$`,
  );
const RAW_JSON_STRINGIFY_RE = /\bJSON\.stringify\s*\(/;

export function detectStaticStringLeaks(text) {
  if (!text || !text.trim()) return [];
  const rules = [];
  const push = (rule) => {
    if (!rules.includes(rule)) rules.push(rule);
  };

  if (UUID_RE.test(text)) push('uuid');
  if (SESSION_ID_RE.test(text) || SESSION_PREFIX_RE.test(text)) push('session_id');
  if (CALL_ID_RE.test(text) || CALL_PREFIX_RE.test(text)) push('call_id');
  if (OU_ID_RE.test(text) || OU_PREFIX_RE.test(text)) push('ou_id');
  if (INTERNAL_TOOL_RE.test(text)) push('internal_tool_name');
  if (ENGLISH_STATE_RES.some((re) => re.test(text))) push('english_state_word');
  if (SANDBOX_EXEC_RE.test(text)) push('sandbox_exec');
  if (TEMP_PATH_RE.test(text)) push('temp_path');
  if (RAW_JSON_RE.test(text)) push('raw_json');

  return rules;
}

function collectSourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectSourceFiles(full, out);
    } else if (
      /\.(tsx|ts)$/.test(entry.name) &&
      !/\.(test|spec)\.(tsx|ts)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function rawIdentifierRuleForPropertyAccess(expr, sourceFile) {
  if (!ts.isPropertyAccessExpression(expr)) return null;
  const property = expr.name.text;
  if (!/^(?:id|[A-Za-z][A-Za-z0-9]*Id)$/.test(property)) return null;

  const expressionText = expr.getText(sourceFile);
  if (
    /\bhumanizeInternalText\s*\(/.test(expressionText) ||
    /\b(?:humanize|redact|label|lookup)[A-Za-z0-9_]*\s*\(/i.test(expressionText)
  ) {
    return null;
  }
  if (/sessionid/i.test(property)) return 'session_id';
  if (/callid/i.test(property)) return 'call_id';
  if (/ouid/i.test(property)) return 'ou_id';
  return 'uuid';
}

function isKnownLabelLookupCall(expr, sourceFile) {
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression.getText(sourceFile);
  return /(?:^|\.)(?:labelFor|descriptionFor|getRowIcon|getPermissionIcon|formatRequesterLabel|roleName|scopeIcon|getHumanToolLabel)$/.test(callee);
}

function inspectRenderedExpression(expr, sourceFile, recordHit) {
  if (!expr) return;
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    inspectRenderedExpression(expr.expression, sourceFile, recordHit);
    return;
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    for (const rule of detectStaticStringLeaks(expr.text)) {
      recordHit(rule, expr.text.trim(), expr.getStart(sourceFile));
    }
    return;
  }

  if (ts.isTemplateExpression(expr)) {
    const fullTemplateText = expr.getText(sourceFile);
    const staticParts = [
      expr.head.text,
      ...expr.templateSpans.map((span) => span.literal.text),
    ];
    for (const part of staticParts) {
      for (const rule of detectStaticStringLeaks(part)) {
        recordHit(rule, fullTemplateText, expr.getStart(sourceFile));
      }
    }
    for (const span of expr.templateSpans) {
      inspectRenderedExpression(span.expression, sourceFile, recordHit);
    }
    return;
  }

  if (ts.isConditionalExpression(expr)) {
    inspectRenderedExpression(expr.whenTrue, sourceFile, recordHit);
    inspectRenderedExpression(expr.whenFalse, sourceFile, recordHit);
    return;
  }

  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      // In `cond && renderedValue`, only `expr.right` is actually rendered
      inspectRenderedExpression(expr.right, sourceFile, recordHit);
      return;
    }
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.PlusToken
    ) {
      const wholeText = expr.getText(sourceFile).trim();
      inspectRenderedExpression(expr.left, sourceFile, (rule, _sample, pos) =>
        recordHit(rule, wholeText, pos),
      );
      inspectRenderedExpression(expr.right, sourceFile, (rule, _sample, pos) =>
        recordHit(rule, wholeText, pos),
      );
    }
    return;
  }

  // Do not treat a JSX element itself (`<Foo ... />`) as a string expression;
  // the AST visitor will visit its children and attributes separately.
  if (
    ts.isJsxElement(expr) ||
    ts.isJsxSelfClosingElement(expr) ||
    ts.isJsxFragment(expr)
  ) {
    return;
  }

  const exprText = expr.getText(sourceFile).trim();

  if (/\bhumanizeInternalText\s*\(/.test(exprText)) return;

  // Check `.replace('{id}', task.id)` or `.replace('{id}', row.eventId ?? '')`
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === 'replace' &&
    expr.arguments.length >= 2
  ) {
    inspectRenderedExpression(
      expr.arguments[1],
      sourceFile,
      (rule, _sample, pos) => recordHit(rule, exprText, pos),
    );
    return;
  }

  const identifierRule = rawIdentifierRuleForPropertyAccess(expr, sourceFile);
  if (identifierRule) {
    recordHit(identifierRule, exprText, expr.getStart(sourceFile));
    return;
  }

  if (ts.isCallExpression(expr)) {
    if (isKnownLabelLookupCall(expr, sourceFile)) return;
    for (const argument of expr.arguments) {
      inspectRenderedExpression(argument, sourceFile, recordHit);
    }
  }

  if (
    RAW_JSON_STRINGIFY_RE.test(exprText) &&
    !/humanizeInternalText/.test(exprText)
  ) {
    recordHit('raw_json', exprText, expr.getStart(sourceFile));
  }
}

export function scanRendererStatic({
  rendererDir = DEFAULT_RENDERER_DIR,
  repoRoot = REPO_ROOT,
} = {}) {
  const files = collectSourceFiles(rendererDir).sort();
  if (files.length === 0) {
    throw new Error(
      `[internal-text-leak-gate] 0 files scanned under ${rendererDir} — refusing to pass silently.`,
    );
  }

  const hits = [];

  for (const absPath of files) {
    const relFile = path.relative(repoRoot, absPath).replace(/\\/g, '/');
    const code = fs.readFileSync(absPath, 'utf8');
    const scriptKind = absPath.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      absPath,
      code,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );

    const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
    if (parseDiagnostics.length > 0) {
      const first = parseDiagnostics[0];
      const msg = ts.flattenDiagnosticMessageText(first.messageText, '\n');
      throw new Error(
        `[internal-text-leak-gate] TypeScript parse error in ${relFile}: ${msg}`,
      );
    }

    const seenInFile = new Set();
    const recordHit = (rule, sample, pos) => {
      const normalizedSample = String(sample).replace(/\s+/g, ' ').trim();
      const key = `${rule}:::${normalizedSample}`;
      if (seenInFile.has(key)) return;
      seenInFile.add(key);
      const { line } = sourceFile.getLineAndCharacterOfPosition(pos);
      hits.push({
        file: relFile,
        line: line + 1,
        rule,
        sample: normalizedSample,
      });
    };

    const isI18nFile = relFile.startsWith('src/renderer/i18n/');

    const visit = (node) => {
      // 1. JSX visible text
      if (ts.isJsxText(node)) {
        const text = node.getText(sourceFile).trim();
        if (text) {
          for (const rule of detectStaticStringLeaks(text)) {
            recordHit(rule, text, node.getStart(sourceFile));
          }
        }
      }

      // 2. JSX child expression `{...}`
      if (
        ts.isJsxExpression(node) &&
        node.expression &&
        (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
      ) {
        const rawSpan = node.getText(sourceFile).trim();
        const expr = node.expression;
        inspectRenderedExpression(expr, sourceFile, (rule, _sample, pos) =>
          recordHit(rule, rawSpan, pos),
        );
      }

      // 3. User-facing JSX attributes
      if (ts.isJsxAttribute(node) && node.initializer) {
        const attrName = node.name.getText(sourceFile);
        if (USER_FACING_JSX_ATTRS.has(attrName)) {
          if (ts.isStringLiteral(node.initializer)) {
            for (const rule of detectStaticStringLeaks(node.initializer.text)) {
              recordHit(
                rule,
                node.initializer.text.trim(),
                node.initializer.getStart(sourceFile),
              );
            }
          } else if (
            ts.isJsxExpression(node.initializer) &&
            node.initializer.expression
          ) {
            inspectRenderedExpression(
              node.initializer.expression,
              sourceFile,
              recordHit,
            );
          }
        }
      }

      // 4. Toast / notification calls
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sourceFile);
        if (
          /(?:^|\.)(?:toast|addToast|showToast|notify)(?:\.(?:error|success|warning|info))?$/.test(
            callee,
          )
        ) {
          for (const arg of node.arguments) {
            inspectRenderedExpression(arg, sourceFile, recordHit);
          }
        }
      }

      // 5. i18n catalog string literals
      if (
        isI18nFile &&
        ts.isPropertyAssignment(node) &&
        (ts.isStringLiteral(node.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(node.initializer))
      ) {
        const text = node.initializer.text.trim();
        for (const rule of detectStaticStringLeaks(text)) {
          recordHit(rule, text, node.initializer.getStart(sourceFile));
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return { filesScanned: files.length, hits };
}

function loadAndValidateEntries(allowlistPath, label) {
  if (!fs.existsSync(allowlistPath)) {
    throw new Error(
      `[internal-text-leak-gate] ${label} not found at ${allowlistPath}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `[internal-text-leak-gate] Failed to parse ${label} JSON (${allowlistPath}): ${err.message}`,
      { cause: err },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `[internal-text-leak-gate] ${label} (${allowlistPath}) must be a JSON array.`,
    );
  }

  for (let i = 0; i < parsed.length; i += 1) {
    const entry = parsed[i];
    if (!entry || typeof entry !== 'object') {
      throw new Error(
        `[internal-text-leak-gate] ${label} entry #${i} must be an object.`,
      );
    }
    if (typeof entry.file !== 'string' || !entry.file.trim()) {
      throw new Error(
        `[internal-text-leak-gate] ${label} entry #${i} is missing a non-empty "file".`,
      );
    }
    if (typeof entry.rule !== 'string' || !VALID_RULES.has(entry.rule)) {
      throw new Error(
        `[internal-text-leak-gate] ${label} entry #${i} (${entry.file}) has invalid "rule": ${JSON.stringify(entry.rule)}.`,
      );
    }
    if (typeof entry.sample !== 'string' || !entry.sample.trim()) {
      throw new Error(
        `[internal-text-leak-gate] ${label} entry #${i} (${entry.file}) is missing a non-empty "sample".`,
      );
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(
        `[internal-text-leak-gate] ${label} entry #${i} (${entry.file} [${entry.rule}]) is missing a non-empty "reason". Every allowlisted leak must name its owning ticket or reason.`,
      );
    }
  }

  return parsed;
}

export function loadAndValidateAllowlist(allowlistPath = DEFAULT_ALLOWLIST_PATH) {
  return loadAndValidateEntries(allowlistPath, 'Allowlist');
}

export function loadAndValidateDynamicAllowlist(
  allowlistPath = DEFAULT_DYNAMIC_ALLOWLIST_PATH,
) {
  return loadAndValidateEntries(allowlistPath, 'Dynamic allowlist');
}

export function evaluateGate({
  rendererDir = DEFAULT_RENDERER_DIR,
  allowlistPath = DEFAULT_ALLOWLIST_PATH,
  repoRoot = REPO_ROOT,
} = {}) {
  const allowlist = loadAndValidateAllowlist(allowlistPath);
  const { filesScanned, hits } = scanRendererStatic({ rendererDir, repoRoot });

  const matchedAllowlistIndices = new Set();
  const unexpectedHits = [];

  for (const hit of hits) {
    const idx = allowlist.findIndex(
      (entry) =>
        entry.file === hit.file &&
        entry.rule === hit.rule &&
        entry.sample.replace(/\s+/g, ' ').trim() === hit.sample,
    );
    if (idx !== -1) {
      matchedAllowlistIndices.add(idx);
    } else {
      unexpectedHits.push(hit);
    }
  }

  const staleEntries = allowlist.filter(
    (_entry, idx) => !matchedAllowlistIndices.has(idx),
  );

  return {
    filesScanned,
    totalHits: hits.length,
    allowlistCount: allowlist.length,
    unexpectedHits,
    staleEntries,
  };
}

function runDynamicSurfaceScan() {
  const vitestBin = path.join(REPO_ROOT, 'node_modules/.bin/vitest');
  const testFile =
    'tests/renderer/components/internalTextLeakDynamicScan.test.tsx';
  const res = spawnSync(vitestBin, ['run', testFile], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  });
  if (res.status !== 0) {
    console.error(
      '[internal-text-leak-gate] ✗ Dynamic surface scan failed:',
    );
    if (res.stdout) console.error(res.stdout);
    if (res.stderr) console.error(res.stderr);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const staticOnly = args.includes('--static-only');

  let result;
  try {
    loadAndValidateDynamicAllowlist();
    result = evaluateGate();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  for (const stale of result.staleEntries) {
    console.warn(
      `[internal-text-leak-gate] ! allowlist entry no longer matches (can be tightened): ${stale.file} [${stale.rule}] "${stale.sample}" (${stale.reason})`,
    );
  }

  if (result.unexpectedHits.length > 0) {
    console.error(
      `[internal-text-leak-gate] ✗ ${result.unexpectedHits.length} un-allowlisted internal-text leak(s) detected in renderer surfaces:`,
    );
    for (const hit of result.unexpectedHits) {
      console.error(
        `  - ${hit.file}:${hit.line} [rule=${hit.rule}] sample=${JSON.stringify(hit.sample)}`,
      );
    }
    console.error(
      'Route internal values through humanizeInternalText (@shared/humanizeInternalText) instead of rendering raw IDs, tool names, English state tokens, sandbox-exec, temp paths, or raw JSON.',
    );
    process.exit(1);
  }

  if (!staticOnly) {
    runDynamicSurfaceScan();
  }

  console.log(
    `[internal-text-leak-gate] ✓ scanned ${result.filesScanned} renderer files (${result.totalHits} allowlisted hit(s), 0 new leaks)${staticOnly ? ' [static-only]' : ' + 4 dynamic surfaces passed'}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
