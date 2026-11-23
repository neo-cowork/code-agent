#!/usr/bin/env node
// 生产产物不得含 Dev 包专用故障注入：
//   1. src-tauri/tauri.conf.json 的 bundle resources 不得引用 dev-fault-inject 模块；
//   2. dist/web/webServer.bundle.cjs、dist/web/webServer.cjs、dist/renderer 里不得出现开关名或日志标记。
// 缺失的产物目录/文件不算失败（门只拦「存在且含禁词」），所以可在未构建的 checkout 上跑配置检查。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_STRINGS = ['NEO_DEV_FAULT', 'dev_fault_inject'];
const MODULE_FILE = 'dev-fault-inject';
const RELEASE_ARTIFACTS = ['dist/web/webServer.bundle.cjs', 'dist/web/webServer.cjs', 'dist/renderer'];

function* walkFiles(target) {
  const stat = statSync(target);
  if (stat.isFile()) {
    yield target;
    return;
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    yield* walkFiles(path.join(target, entry.name));
  }
}

export function checkNoDevFaultInRelease(root = process.cwd()) {
  const violations = [];
  const confPath = path.join(root, 'src-tauri/tauri.conf.json');
  if (existsSync(confPath)) {
    const conf = JSON.parse(readFileSync(confPath, 'utf8'));
    const resources = conf?.bundle?.resources ?? {};
    const entries = Array.isArray(resources) ? resources.map((r) => [r, r]) : Object.entries(resources);
    for (const [from, to] of entries) {
      if (String(from).includes(MODULE_FILE) || String(to).includes(MODULE_FILE)) {
        violations.push(`src-tauri/tauri.conf.json bundle.resources references ${MODULE_FILE}: ${from}`);
      }
    }
  }
  for (const rel of RELEASE_ARTIFACTS) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    for (const file of walkFiles(abs)) {
      const text = readFileSync(file, 'latin1');
      for (const needle of FORBIDDEN_STRINGS) {
        if (text.includes(needle)) {
          violations.push(`${path.relative(root, file)} contains ${needle}`);
        }
      }
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = checkNoDevFaultInRelease(process.cwd());
  if (violations.length > 0) {
    for (const line of violations) console.error(`✗ ${line}`);
    process.exit(1);
  }
  console.log('✓ no dev fault injection in release resources/artifacts');
}
