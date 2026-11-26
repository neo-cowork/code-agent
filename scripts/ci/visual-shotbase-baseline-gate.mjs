#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, '../..');
const specPath = 'tests/e2e/visual-shotbase.spec.ts';
const snapshotDir = `${specPath}-snapshots`;
const linuxBaselines = [
  `${snapshotDir}/dangerous-command-approval-light-chromium-linux.png`,
  `${snapshotDir}/dangerous-command-approval-dark-chromium-linux.png`,
];
const receiptPath = `${snapshotDir}/rerecord-receipt.json`;
const ciRunUrlPattern = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+/;

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const knownArgs = new Set(['--repo-root', '--base-ref', '--write-receipt']);
const unknownArgs = args.filter((arg, index) => arg.startsWith('--')
  ? !knownArgs.has(arg)
  : index === 0 || !knownArgs.has(args[index - 1]));
if (unknownArgs.length > 0) {
  console.error(`[visual-shotbase-baseline-gate] ✗ 不支持的参数：${unknownArgs.join(', ')}`);
  process.exit(1);
}

const repoRoot = path.resolve(option('--repo-root', defaultRepoRoot));
const baseRef = option('--base-ref', process.env.VISUAL_SHOTBASE_BASE_REF || 'origin/main');

function fail(message) {
  console.error(`[visual-shotbase-baseline-gate] ✗ ${message}`);
  process.exit(1);
}

function git(argsList, options = {}) {
  try {
    return execFileSync('git', argsList, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    fail(`git ${argsList.join(' ')} 失败${stderr ? `：${stderr}` : ''}`);
  }
}

function readCurrent(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    return fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    fail(`读取 ${relativePath} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function readAtRef(ref, relativePath) {
  return git(['show', `${ref}:${relativePath}`]);
}

function screenshotContractTokens(source, label) {
  const sourceFile = ts.createSourceFile(
    specPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const screenshotStatements = [];

  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'toHaveScreenshot'
    ) {
      let statement = node;
      while (statement.parent && !ts.isExpressionStatement(statement)) {
        statement = statement.parent;
      }
      if (!ts.isExpressionStatement(statement)) {
        fail(`${label} 中的 toHaveScreenshot 不在独立语句内，无法界定截图契约`);
      }
      screenshotStatements.push(statement);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (screenshotStatements.length !== 1) {
    fail(`${label} 应有且只有 1 个 toHaveScreenshot，实际为 ${screenshotStatements.length}`);
  }

  // 从文件开头到截图语句的 token 都会影响画面。扫描时忽略注释和空白，
  // 避免文案注释或格式化触发无意义的 PNG 重录。
  const contractSource = source.slice(0, screenshotStatements[0].end);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    contractSource,
  );
  const tokens = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(`${token}:${scanner.getTokenText()}`);
  }
  if (tokens.length === 0) fail(`${label} 截图契约 token 为 0，门已空转`);
  return tokens.join('\n');
}

function lines(value) {
  return value ? value.split('\n').filter(Boolean) : [];
}

function changedPathsSince(ref) {
  const changed = new Set(lines(git([
    'diff',
    '--name-only',
    '--diff-filter=ACMR',
    ref,
    '--',
    specPath,
    snapshotDir,
  ])));
  for (const untracked of lines(git(['ls-files', '--others', '--exclude-standard', '--', snapshotDir]))) {
    changed.add(untracked);
  }
  return changed;
}

function latestCommittedContractChange(baseSha, baseContract) {
  const commits = lines(git([
    'rev-list',
    '--reverse',
    `${baseSha}..HEAD`,
    '--',
    specPath,
  ]));
  let previousContract = baseContract;
  let latestChange;

  for (const commit of commits) {
    const contract = screenshotContractTokens(
      readAtRef(commit, specPath),
      `commit ${commit.slice(0, 10)}`,
    );
    if (contract !== previousContract) latestChange = commit;
    previousContract = contract;
  }
  return latestChange;
}

function darwinSnapshotsInWorkingTree() {
  const absoluteDir = path.join(repoRoot, snapshotDir);
  let entries;
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch (error) {
    fail(`读取基线目录 ${snapshotDir} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('-chromium-darwin.png'))
    .map((entry) => `${snapshotDir}/${entry.name}`)
    .sort();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function baselineHashes() {
  const hashes = {};
  for (const baseline of linuxBaselines) {
    const absolutePath = path.join(repoRoot, baseline);
    if (!fs.existsSync(absolutePath)) fail(`缺少 Linux 视觉基线：${baseline}`);
    hashes[baseline] = sha256(fs.readFileSync(absolutePath));
  }
  return hashes;
}

// 回执只能证明「契约哈希 + PNG 字节哈希」彼此对得上，证明不了 CI 真的重录过；
// 门无法核实 ciRunUrl 指向的运行。完整性只靠这几个哈希相等，ciRunUrl 仅供人工追溯。
function checkReceipt(contract) {
  let receipt;
  try {
    receipt = JSON.parse(readCurrent(receiptPath));
  } catch (error) {
    return `${receiptPath} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`;
  }
  if (receipt === null || typeof receipt !== 'object') return `${receiptPath} 顶层必须是对象`;
  if (receipt.contractSha256 !== sha256(contract)) {
    return `${receiptPath} 的 contractSha256 与当前截图契约不一致（回执是针对旧版 spec 生成的）`;
  }
  const recorded = receipt.baselineSha256;
  if (recorded === null || typeof recorded !== 'object') return `${receiptPath} 的 baselineSha256 缺失或不是对象`;
  const actual = baselineHashes();
  for (const baseline of linuxBaselines) {
    if (recorded[baseline] !== actual[baseline]) {
      return `${receiptPath} 的 baselineSha256[${baseline}] 与磁盘上 PNG 的真实 sha256 不一致`;
    }
  }
  if (typeof receipt.ciRunUrl !== 'string' || !ciRunUrlPattern.test(receipt.ciRunUrl)) {
    return `${receiptPath} 的 ciRunUrl 缺失或格式不对（需形如 https://github.com/<owner>/<repo>/actions/runs/<id>）`;
  }
  return undefined;
}

const writeReceiptUrl = option('--write-receipt');
if (args.includes('--write-receipt')) {
  if (!writeReceiptUrl || !ciRunUrlPattern.test(writeReceiptUrl)) {
    fail('--write-receipt 需要形如 https://github.com/<owner>/<repo>/actions/runs/<id> 的 CI 运行地址');
  }
  const contract = screenshotContractTokens(readCurrent(specPath), '当前工作树');
  const receipt = {
    contractSha256: sha256(contract),
    baselineSha256: baselineHashes(),
    ciRunUrl: writeReceiptUrl,
  };
  fs.writeFileSync(path.join(repoRoot, receiptPath), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`[visual-shotbase-baseline-gate] ✓ 已写入 ${receiptPath}`);
  process.exit(0);
}

git(['rev-parse', '--show-toplevel']);
const baseSha = git(['merge-base', 'HEAD', baseRef]);
if (!baseSha) fail(`HEAD 与 ${baseRef} 的 merge-base 为空`);

const darwinSnapshots = darwinSnapshotsInWorkingTree();
if (darwinSnapshots.length > 0) {
  fail(
    `发现 macOS 视觉基线：${darwinSnapshots.join(', ')}。`
    + '本用例只接受 Playwright 1.60.0 的 Linux/Chromium 产物，不要用 -darwin 后缀冒充 Linux 基线。',
  );
}

const baseContract = screenshotContractTokens(readAtRef(baseSha, specPath), `${baseRef}@${baseSha}`);
const headContract = screenshotContractTokens(readAtRef('HEAD', specPath), 'HEAD');
const currentContract = screenshotContractTokens(readCurrent(specPath), '当前工作树');

let baselineChangeBoundary;
if (headContract !== currentContract) {
  // 本地反向变异或未提交修改：不能拿本分支更早改过的 PNG 充数。
  baselineChangeBoundary = 'HEAD';
} else if (baseContract !== headContract) {
  const contractCommit = latestCommittedContractChange(baseSha, baseContract);
  if (!contractCommit) fail('截图契约已变化，但无法定位对应提交');
  // PNG 与截图契约同提交更新合法；更早的 PNG 不算同步。
  baselineChangeBoundary = `${contractCommit}^`;
}

if (baselineChangeBoundary) {
  const changedPaths = changedPathsSince(baselineChangeBoundary);
  const missingBaselines = linuxBaselines.filter((baseline) => !changedPaths.has(baseline));
  if (missingBaselines.length > 0) {
    const guide = '处理办法二选一：① 在 Playwright 1.60.0 的 Linux/Chromium 环境重生成 light 和 dark 两张 PNG 并提交；'
      + '② 若 CI 重录后两张 PNG 与现有字节完全一致（没有 git diff 可交），运行 '
      + '`node scripts/ci/visual-shotbase-baseline-gate.mjs --write-receipt <CI run URL>` 并提交生成的 '
      + `${receiptPath}。`;
    if (!changedPaths.has(receiptPath)) {
      fail(
        `你改了截图前的页面状态但没重生成基线。当前未变更：${missingBaselines.join(', ')}。${guide}`,
      );
    }
    const problem = checkReceipt(currentContract);
    if (problem) fail(`重录回执无效：${problem}。${guide}`);
  }
}

for (const baseline of linuxBaselines) {
  if (!fs.existsSync(path.join(repoRoot, baseline))) {
    fail(`缺少 Linux 视觉基线：${baseline}`);
  }
}

console.log(
  `[visual-shotbase-baseline-gate] ✓ 截图契约与 Linux 基线同步（base=${baseSha.slice(0, 10)}）`,
);
