#!/usr/bin/env node
// check-no-direct-app-exec — 红线静态门：脚本不得直接 exec *.app/Contents/MacOS/*。
// 沙箱里直接执行 bundle 内二进制会让 AppKit 拿不到 WindowServer（_RegisterApplication abort，
// 弹系统崩溃框）。GUI app 只能经 LaunchServices（open）启动。
//
// 判据：scripts/ 下 .mjs/.js/.ts/.sh 文件里出现「Contents/MacOS」字面量、拆分形态
// （'Contents', 'MacOS' / 单独的 'MacOS' 段）或 code-agent-tauri，且
//   - JS/TS：同文件有 spawn/exec 系调用；
//   - sh：该行不是注释且不是 pgrep/pkill 过滤。
// 命中且不在 ALLOWLIST 即红。用法：node scripts/ci/check-no-direct-app-exec.mjs [--root <dir>]
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SELF = 'scripts/ci/check-no-direct-app-exec.mjs';

// 每条必须写清楚为何不违反红线。可选 match：只豁免包含该子串的行（其余行仍受检）。
const ALLOWLIST = [
  { file: 'scripts/desktop-shell-packaged-smoke.mjs', match: 'isDevApp', reason: '正则匹配 ps 输出里的进程命令行（只读），不执行' },
  { file: 'scripts/lib/desktop-shell-app-launch.mjs', match: "'Contents', 'MacOS'", reason: '拼 ps 命令行前缀用于只读匹配，启动走 open' },
  { file: 'scripts/tauri-install.sh', reason: 'pkill -f 按 bundle 路径前缀过滤，只匹配不执行' },
  { file: 'scripts/tauri-install-dev.sh', reason: 'pkill -f 按 bundle 路径前缀过滤，只匹配不执行' },
  { file: 'scripts/run-dev-slot.sh', reason: '注释说明红线 + pgrep 过滤，启动走 open' },
  { file: 'scripts/neo-drive/neo-drive.mjs', reason: '仅用作 pgrep 进程命令行匹配模式，不执行' },
  { file: 'scripts/tauri-release-bundle.sh', reason: 'find 只读定位二进制做 Mach-O 检查，不执行' },
  { file: 'scripts/lib/tauri-slot-process-guard.sh', reason: '比对进程真实可执行路径（ps/lsof 读取），不执行' },
  { file: 'scripts/verify-updater-pubkey.mjs', reason: '只读二进制字节检查更新公钥（readFileSync），不执行' },
  { file: 'scripts/verify-windows-release.mjs', reason: 'Windows .exe 分支，非 macOS bundle，只读检查' },
  { file: 'scripts/verify-browser-runtime.mjs', reason: '第三方 Chrome/Edge 二进制路径，不是 Neo app' },
  { file: 'scripts/release-renderer-probe.mjs', reason: '第三方 Chrome 二进制（headless 探针），不是 Neo app' },
  { file: 'scripts/acceptance/browser-computer-system-chrome.ts', reason: '第三方系统 Chrome 路径，不是 Neo app' },
  { file: 'scripts/fetch-cua-driver.sh', reason: '第三方 cua-driver 二进制的下载/重签流程，不是 Neo app' },
  { file: 'scripts/stage-cua-driver-resource.sh', reason: '第三方 cua-driver 二进制存在性检查（-x），不执行 Neo app' },
  { file: 'scripts/acceptance/surface-execution-computer-smoke.ts', reason: '拼装第三方 cua-driver helper 路径，不是 Neo app' },
  { file: 'scripts/acceptance/surface-execution-cross-surface-smoke.ts', reason: '拼装第三方 cua-driver helper 路径，不是 Neo app' },
];

const EXTS = new Set(['.mjs', '.js', '.ts', '.sh']);
const TARGET_RE = /Contents\/MacOS|['"`]Contents['"`]\s*,\s*['"`]MacOS['"`]|['"`]MacOS['"`]|code-agent-tauri/;
const EXEC_RE = /\b(?:spawn|spawnSync|exec|execFile|execFileSync|execSync|execa)\s*\(/;

const rootArg = process.argv.indexOf('--root');
const root = path.resolve(rootArg >= 0 ? process.argv[rootArg + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const scriptsDir = path.join(root, 'scripts');
let files;
try {
  files = walk(scriptsDir, []);
} catch (err) {
  console.error(`[check-no-direct-app-exec] ✗ 自检失败：无法枚举 ${scriptsDir}：${err.message}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`[check-no-direct-app-exec] ✗ 自检失败：${scriptsDir} 下扫到 0 个脚本，门本身失效`);
  process.exit(1);
}

const hits = [];
for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (rel === SELF) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const isShell = file.endsWith('.sh');
  const hasExec = !isShell && lines.some((l) => EXEC_RE.test(l));
  lines.forEach((line, i) => {
    if (!TARGET_RE.test(line)) return;
    if (isShell) {
      if (/^\s*#/.test(line) || /\b(pgrep|pkill)\b/.test(line)) return;
    } else if (!hasExec || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
    hits.push({ rel, line: i + 1, text: line.trim().slice(0, 160) });
  });
}

const isAllowed = (h) => ALLOWLIST.some((e) => e.file === h.rel && (!e.match || h.text.includes(e.match)));
const bad = hits.filter((h) => !isAllowed(h));
console.log(`[check-no-direct-app-exec] 扫描 ${files.length} 个脚本，命中 ${hits.length} 处，其中白名单外 ${bad.length} 处`);
if (bad.length > 0) {
  for (const h of bad) console.error(`  ${h.rel}:${h.line}: ${h.text}`);
  console.error('[check-no-direct-app-exec] ✗ 禁止直接 exec *.app/Contents/MacOS/*：请改走 `open`（见 scripts/lib/desktop-shell-app-launch.mjs / scripts/run-dev-slot.sh）。');
  console.error('  若确属第三方二进制 / 只读 / 非 macOS 分支，在本文件 ALLOWLIST 加 {file, reason}。');
  process.exit(1);
}
console.log('[check-no-direct-app-exec] ✓ 通过');
