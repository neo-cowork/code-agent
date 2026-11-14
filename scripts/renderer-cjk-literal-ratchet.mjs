#!/usr/bin/env node
// ============================================================================
// renderer-cjk-literal-ratchet — renderer 渲染文案与 shared/contract CJK 字面量棘轮
// ============================================================================
//
// N-FIX-EN-UI-HARDCODED-ZH-SYSTEMIC 扫描口径：
//   - 扫描根：
//     1) src/renderer/**/*.{ts,tsx}（排除任意 i18n/ 目录、__tests__/、*.test.*、*.spec.*、*.d.ts）
//        计数目标（eslint-plugin-i18next mode: 'jsx-only' 同口径）：
//          · JsxText 节点含 CJK
//          · JsxAttribute 的字符串值含 CJK：attr="中文"，以及只多包一层花括号的
//            attr={'中文'} / attr={`中文 ${n}`}（同一个渲染位置，不留换个写法就绕过的口子）
//          · JSX 子节点里直接写的字符串：<p>{'中文'}</p> / <p>{`中文 ${n}`}</p>
//        三元、|| 兜底、变量、函数入参里的字符串不计（那是 2000+ 处匹配表/数据表，不在本门口径内）。
//     2) src/shared/contract/**/*.{ts,tsx}（排除 __tests__/、*.test.*、*.spec.*、*.d.ts）
//        计数目标：任意 CJK 字符串或模板字面量（StringLiteral / NoSubstitutionTemplateLiteral /
//        TemplateExpression，整条模板表达式含至少一段 CJK 静态片段计 1）。
//   - 基线文件：scripts/renderer-cjk-literal-baseline.json（按文件计数，只降不升）。
//     · 已有文件计数不得超过基线；
//     · 基线外文件命中 > 0 立即失败；
//     · 计数低于基线同样失败（基线过期）：清理后必须跑 --update-baseline 把基线收紧到实际值，
//       不留「基线比现状高」的余量，手工把数字改大也因此直接红；
//     · --update-baseline 仅允许下调或移除已清零条目，任何上调或新增文件一律拒绝并退出 1；
//     · 手工上调也拦：工作区基线逐条对比已提交的基线（与 origin/main 的 merge-base；该处还没有
//       基线文件时退到 HEAD），数字变大或新增条目必须是带非空 reason 的对象条目，否则失败。
//       比较基点可用 RENDERER_CJK_RATCHET_BASE_REF 指定；
//     · 不支持行内豁免注释（禁止 // cjk-allow 类逃生口）；合法例外写入基线并附非空 reason。
//   - Fail loud：0 扫描文件、0 命中目标、TS 解析报错、基线损坏、git 仓库内解析不出比较基点
//     或参数未知均非零退出。
// ============================================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..');

const RENDERER_ROOT = 'src/renderer';
const CONTRACT_ROOT = 'src/shared/contract';
const DEFAULT_BASELINE_REL = 'scripts/renderer-cjk-literal-baseline.json';
const BASE_REF_ENV = 'RENDERER_CJK_RATCHET_BASE_REF';
const DEFAULT_BASE_REFS = ['origin/main', 'main'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isExcludedFile(relPosix, excludeI18n) {
  const parts = relPosix.split('/');
  const name = parts[parts.length - 1];
  if (parts.includes('__tests__') || parts.includes('node_modules')) return true;
  if (excludeI18n && parts.includes('i18n')) return true;
  if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(name)) return true;
  if (name.endsWith('.d.ts')) return true;
  return false;
}

function collectFiles(rootDir, subRoot, { excludeI18n }) {
  const absRoot = path.resolve(rootDir, subRoot);
  if (!fs.existsSync(absRoot)) {
    throw new Error(`扫描根不存在：${subRoot} (${absRoot})`);
  }
  const stat = fs.statSync(absRoot);
  if (!stat.isDirectory()) {
    throw new Error(`扫描根不是目录：${subRoot} (${absRoot})`);
  }

  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        if (excludeI18n && entry.name === 'i18n') continue;
        walk(fullPath);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        const relPosix = toPosix(path.relative(rootDir, fullPath));
        if (!isExcludedFile(relPosix, excludeI18n)) {
          out.push({ absPath: fullPath, relPosix });
        }
      }
    }
  };
  walk(absRoot);
  return out.sort((a, b) => a.relPosix.localeCompare(b.relPosix));
}

function formatParseDiagnostic(diagnostic, sourceFile) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (typeof diagnostic.start !== 'number') return message;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  return `${line + 1}:${character + 1} ${message}`;
}

function parseSourceFile(absPath, relPosix) {
  const source = fs.readFileSync(absPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    absPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const details = parseDiagnostics
      .slice(0, 5)
      .map((diagnostic) => formatParseDiagnostic(diagnostic, sourceFile))
      .join('\n  ');
    throw new Error(`TypeScript 解析失败：${relPosix}\n  ${details}`);
  }
  return sourceFile;
}

function makeFinding(sourceFile, relPosix, node, kind) {
  const start = node.getStart(sourceFile);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  const preview = node.getText(sourceFile).replace(/\s+/g, ' ').trim().slice(0, 140);
  return {
    file: relPosix,
    line: line + 1,
    column: character + 1,
    kind,
    preview,
  };
}

function isHanPlainString(node) {
  return (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && HAN_RE.test(node.text);
}

function isHanTemplate(node) {
  return ts.isTemplateExpression(node) &&
    (HAN_RE.test(node.head.text) || node.templateSpans.some((span) => HAN_RE.test(span.literal.text)));
}

function scanRendererFile(sourceFile, relPosix) {
  const findings = [];
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      if (HAN_RE.test(node.text)) findings.push(makeFinding(sourceFile, relPosix, node, 'jsx-text'));
    } else if (ts.isJsxAttribute(node)) {
      const value = node.initializer && ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (value && (isHanPlainString(value) || isHanTemplate(value))) {
        findings.push(makeFinding(sourceFile, relPosix, value, 'jsx-attribute'));
      }
    } else if (
      ts.isJsxExpression(node) &&
      !ts.isJsxAttribute(node.parent) &&
      node.expression &&
      (isHanPlainString(node.expression) || isHanTemplate(node.expression))
    ) {
      findings.push(makeFinding(sourceFile, relPosix, node.expression, 'jsx-text'));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function scanContractFile(sourceFile, relPosix) {
  const findings = [];
  const visit = (node) => {
    if (isHanPlainString(node)) {
      findings.push(makeFinding(sourceFile, relPosix, node, 'contract-string'));
    } else if (isHanTemplate(node)) {
      findings.push(makeFinding(sourceFile, relPosix, node, 'contract-template'));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function scanAll(rootDir) {
  const rendererFiles = collectFiles(rootDir, RENDERER_ROOT, { excludeI18n: true });
  const contractFiles = collectFiles(rootDir, CONTRACT_ROOT, { excludeI18n: false });

  if (rendererFiles.length === 0) {
    throw new Error(`扫描 0 个源文件：${RENDERER_ROOT}`);
  }
  if (contractFiles.length === 0) {
    throw new Error(`扫描 0 个源文件：${CONTRACT_ROOT}`);
  }

  const findingsByFile = new Map();
  let totalTargets = 0;

  for (const { absPath, relPosix } of rendererFiles) {
    const sourceFile = parseSourceFile(absPath, relPosix);
    const findings = scanRendererFile(sourceFile, relPosix);
    if (findings.length > 0) {
      findingsByFile.set(relPosix, findings);
      totalTargets += findings.length;
    }
  }

  for (const { absPath, relPosix } of contractFiles) {
    const sourceFile = parseSourceFile(absPath, relPosix);
    const findings = scanContractFile(sourceFile, relPosix);
    if (findings.length > 0) {
      findingsByFile.set(relPosix, findings);
      totalTargets += findings.length;
    }
  }

  const totalScanned = rendererFiles.length + contractFiles.length;
  if (totalTargets === 0) {
    throw new Error(`扫描 ${totalScanned} 个源文件但命中 0 个 CJK 字面量；扫描器或口径可能已失效`);
  }

  return {
    rendererScannedCount: rendererFiles.length,
    contractScannedCount: contractFiles.length,
    totalScannedCount: totalScanned,
    totalTargets,
    findingsByFile,
  };
}

function normalizeBaselineEntry(file, raw) {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw <= 0) {
      throw new Error(`基线文件条目无效（计数须为正整数）：${file}=${String(raw)}`);
    }
    return { count: raw, reason: undefined };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const { count, reason, ...rest } = raw;
    if (Object.keys(rest).length > 0) {
      throw new Error(`基线文件条目含未知字段（${Object.keys(rest).join(', ')}）：${file}`);
    }
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`基线文件条目 count 须为正整数：${file}`);
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new Error(`基线对象条目必须提供非空 reason：${file}`);
    }
    return { count, reason: reason.trim() };
  }
  throw new Error(`基线文件条目格式无效：${file}`);
}

function parseBaseline(jsonText, baselinePath) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`基线 JSON 解析失败（${baselinePath}）：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`基线格式无效（须为 JSON 对象）：${baselinePath}`);
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`基线 schemaVersion 无效（期望 1）：${String(parsed.schemaVersion)}`);
  }
  if (!parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    throw new Error(`基线 files 字段缺失或格式无效：${baselinePath}`);
  }
  const entries = new Map();
  let baselineTotal = 0;
  for (const [file, value] of Object.entries(parsed.files)) {
    if (typeof file !== 'string' || !file.trim()) {
      throw new Error('基线含空文件路径键');
    }
    const normalized = normalizeBaselineEntry(file, value);
    entries.set(file, normalized);
    baselineTotal += normalized.count;
  }
  return {
    raw: parsed,
    entries,
    baselineTotal,
  };
}

function readBaseline(baselinePath) {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`基线文件不存在：${baselinePath}`);
  }
  return parseBaseline(fs.readFileSync(baselinePath, 'utf8'), baselinePath);
}

function runGit(repoRoot, args) {
  return spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

// 已提交的基线：与 origin/main 的 merge-base 上那一份；那里还没有基线文件（本门首次引入的分支）
// 时退到 HEAD。两处都没有 = 首次初始化，没有可比对象。每条跳过原因都单独说明，不静默。
function readCommittedBaseline(repoRoot, baselinePath) {
  const topLevel = runGit(repoRoot, ['rev-parse', '--show-toplevel']);
  if (topLevel.error || topLevel.status !== 0) {
    return { skipped: `${repoRoot} 不在 git 工作树内` };
  }
  const relPath = toPosix(path.relative(fs.realpathSync(topLevel.stdout.trim()), fs.realpathSync(baselinePath)));
  if (relPath.startsWith('../') || path.isAbsolute(relPath)) {
    return { skipped: `基线文件不在仓库内（${baselinePath}）` };
  }

  const configured = process.env[BASE_REF_ENV];
  const candidates = configured ? [configured] : DEFAULT_BASE_REFS;
  let mergeBase = '';
  for (const candidate of candidates) {
    const result = runGit(repoRoot, ['merge-base', 'HEAD', candidate]);
    if (result.status === 0 && result.stdout.trim()) {
      mergeBase = result.stdout.trim();
      break;
    }
  }
  if (!mergeBase) {
    throw new Error(
      `无法解析比较基点（试过 ${candidates.join(' / ')}）；` +
      `设置 ${BASE_REF_ENV} 或确保 origin/main / main 可用（浅克隆先 git fetch --unshallow）`,
    );
  }

  for (const ref of [mergeBase, 'HEAD']) {
    const shown = runGit(repoRoot, ['show', `${ref}:${relPath}`]);
    if (shown.status === 0) {
      const label = ref === 'HEAD' ? 'HEAD' : ref.slice(0, 9);
      return { label, entries: parseBaseline(shown.stdout, `${label}:${relPath}`).entries };
    }
  }
  return { skipped: `比较基点 ${mergeBase.slice(0, 9)} 与 HEAD 都还没有已提交的基线（首次引入）` };
}

function serializeBaselineFiles(entriesMap) {
  const sortedKeys = [...entriesMap.keys()].sort((a, b) => a.localeCompare(b));
  const out = {};
  for (const key of sortedKeys) {
    const entry = entriesMap.get(key);
    out[key] = entry.reason ? { count: entry.count, reason: entry.reason } : entry.count;
  }
  return out;
}

function parseCliArgs(argv) {
  let repoRoot = defaultRepoRoot;
  let baselineArg = DEFAULT_BASELINE_REL;
  let updateBaseline = false;
  let initBaseline = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--update-baseline') {
      updateBaseline = true;
    } else if (arg === '--init-baseline') {
      initBaseline = true;
    } else if (arg === '--repo-root') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--repo-root 需要目录参数');
      repoRoot = path.resolve(next);
      i += 1;
    } else if (arg === '--baseline') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--baseline 需要文件路径参数');
      baselineArg = next;
      i += 1;
    } else {
      throw new Error(`不支持的参数：${arg}`);
    }
  }

  const baselinePath = path.isAbsolute(baselineArg)
    ? baselineArg
    : path.resolve(repoRoot, baselineArg);

  return { repoRoot, baselinePath, updateBaseline, initBaseline };
}

function formatFindingLines(findings, limit = 40) {
  const lines = [];
  if (findings.length > limit) {
    const head = Math.floor(limit / 2);
    const tail = limit - head;
    for (const f of findings.slice(0, head)) {
      lines.push(`  ${f.file}:${f.line}:${f.column} [${f.kind}] ${f.preview}`);
    }
    lines.push(`  …省略中间 ${findings.length - limit} 处…`);
    for (const f of findings.slice(-tail)) {
      lines.push(`  ${f.file}:${f.line}:${f.column} [${f.kind}] ${f.preview}`);
    }
    return lines.join('\n');
  }
  for (const f of findings) {
    lines.push(`  ${f.file}:${f.line}:${f.column} [${f.kind}] ${f.preview}`);
  }
  return lines.join('\n');
}

function runCli() {
  try {
    const { repoRoot, baselinePath, updateBaseline, initBaseline } = parseCliArgs(process.argv.slice(2));
    const report = scanAll(repoRoot);

    if (initBaseline) {
      if (fs.existsSync(baselinePath)) {
        throw new Error(`基线已存在，禁止 --init-baseline 覆盖：${baselinePath}（下调请用 --update-baseline）`);
      }
      const initialEntries = new Map();
      for (const [file, findings] of report.findingsByFile.entries()) {
        initialEntries.set(file, { count: findings.length, reason: undefined });
      }
      const payload = {
        schemaVersion: 1,
        files: serializeBaselineFiles(initialEntries),
      };
      fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
      fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      console.log(`[renderer-cjk-literal-ratchet] 已初始化基线：${initialEntries.size} 个文件，${report.totalTargets} 处命中`);
      return;
    }

    const baseline = readBaseline(baselinePath);

    console.log(
      `[renderer-cjk-literal-ratchet] 扫描 ${report.totalScannedCount} 个源文件` +
      `（${RENDERER_ROOT}=${report.rendererScannedCount}, ${CONTRACT_ROOT}=${report.contractScannedCount}）`,
    );

    const allFiles = [...new Set([...baseline.entries.keys(), ...report.findingsByFile.keys()])]
      .sort((a, b) => a.localeCompare(b));

    for (const file of allFiles) {
      const current = report.findingsByFile.get(file)?.length ?? 0;
      const base = baseline.entries.get(file)?.count ?? 0;
      console.log(`[renderer-cjk-literal-ratchet]   ${file}: current=${current} baseline=${base}`);
    }

    console.log(
      `[renderer-cjk-literal-ratchet] 汇总：files=${report.findingsByFile.size}/${baseline.entries.size} ` +
      `targets=${report.totalTargets}/${baseline.baselineTotal}`,
    );

    const regressions = [];
    const regressionFindings = [];
    const lowered = [];

    for (const file of allFiles) {
      const findings = report.findingsByFile.get(file) ?? [];
      const current = findings.length;
      const baseEntry = baseline.entries.get(file);
      const base = baseEntry?.count ?? 0;

      if (current > base) {
        regressions.push({ file, current, base });
        regressionFindings.push(...findings);
      } else if (current < base) {
        lowered.push({ file, current, base });
      }
    }

    if (regressions.length > 0) {
      const summary = regressions
        .map((r) => `  ${r.file}: current=${r.current} > baseline=${r.base} (+${r.current - r.base})`)
        .join('\n');
      const actionHint = updateBaseline
        ? '--update-baseline 拒绝上调基线或新增命中文件；请将新增中文迁入 src/renderer/i18n/ 语言包。'
        : '新增渲染中文必须迁入 src/renderer/i18n/ 语言包（contract 文案改用稳定键或双语字典），禁止硬编码。';
      throw new Error(
        `检测到 ${regressions.length} 个文件超出 CJK 字面量棘轮基线：\n${summary}\n` +
        `${actionHint}\n命中位置：\n${formatFindingLines(regressionFindings)}`,
      );
    }

    const committed = readCommittedBaseline(repoRoot, baselinePath);
    if (committed.skipped) {
      console.log(`[renderer-cjk-literal-ratchet] 未做手工上调比对：${committed.skipped}`);
    } else {
      const raised = [];
      const reasoned = [];
      for (const [file, entry] of baseline.entries.entries()) {
        const committedCount = committed.entries.get(file)?.count ?? 0;
        if (entry.count <= committedCount) continue;
        (entry.reason ? reasoned : raised).push({ file, count: entry.count, committedCount, reason: entry.reason });
      }
      for (const r of reasoned) {
        console.log(
          `[renderer-cjk-literal-ratchet] 例外上调（对比 ${committed.label}）：` +
          `${r.file} ${r.committedCount} → ${r.count}，reason=${r.reason}`,
        );
      }
      if (raised.length > 0) {
        const summary = raised
          .map((r) => `  ${r.file}: 已提交基线=${r.committedCount} → 工作区基线=${r.count}`)
          .join('\n');
        throw new Error(
          `基线被手工上调（对比 ${committed.label}），${raised.length} 个条目：\n${summary}\n` +
          '基线只降不升：把新增中文迁入 src/renderer/i18n/ 语言包后还原这些条目；' +
          '确属合法例外（如文件改名）时写成 { "count": N, "reason": "<原因>" }。',
        );
      }
    }

    if (updateBaseline) {
      const nextEntries = new Map();
      for (const [file, baseEntry] of baseline.entries.entries()) {
        const current = report.findingsByFile.get(file)?.length ?? 0;
        if (current > 0) {
          nextEntries.set(file, { count: current, reason: baseEntry.reason });
        }
      }
      const nextPayload = {
        ...baseline.raw,
        schemaVersion: 1,
        files: serializeBaselineFiles(nextEntries),
      };
      fs.writeFileSync(baselinePath, `${JSON.stringify(nextPayload, null, 2)}\n`, 'utf8');
      console.log(
        `[renderer-cjk-literal-ratchet] ✓ 已下调基线：下调 ${lowered.length} 个文件，` +
        `当前 ${nextEntries.size} 个文件 / ${report.totalTargets} 处命中`,
      );
      return;
    }

    if (lowered.length > 0) {
      const summary = lowered
        .map((l) => `  ${l.file}: current=${l.current} < baseline=${l.base}`)
        .join('\n');
      throw new Error(
        `基线过期：${lowered.length} 个文件的实际计数低于基线（共 ${baseline.baselineTotal - report.totalTargets} 处）：\n${summary}\n` +
        '运行 node scripts/renderer-cjk-literal-ratchet.mjs --update-baseline 把基线收紧到实际值并一并提交；' +
        '基线不允许比现状高（手工改大数字同样会落到这里）。',
      );
    }
    console.log('[renderer-cjk-literal-ratchet] ✓ 等于基线，通过（未新增）');
  } catch (error) {
    console.error(`[renderer-cjk-literal-ratchet] ✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runCli();
}
