#!/usr/bin/env node
// ============================================================================
// check-settings-jargon — 设置页中文文案英文术语门（棘轮）
// ============================================================================
// 词表：src/renderer/i18n/settingsTerms.json（与渲染端 settingsVocabulary.ts 共读同一份）。
// 规则：扫描面内「含 CJK 的字符串/JSX 文本」若命中 mode=enforce 的 term（忽略大小写、
//       单复数、空格/连字符变体；allow 里的字面量先抹掉），则必须在 baseline 里有
//       (文件, 词) 条目且命中数 <= baseline.count，否则红。mode=report 只列出不拦。
// baseline：scripts/settings-jargon-baseline.json，每条带 reason（归属单号或 unowned stock），
//           count 只降不升；实际低于 count 时提示收紧（不拦）。
// 豁免：违规所在物理行带 `// jargon-allow: <理由>`。
// 扫描面：src/renderer/i18n/zhSettings*.ts、onboarding.ts、components/features/settings/**/*.tsx
//
// 用法：node scripts/check-settings-jargon.mjs [--root <仓库根>] [--baseline <文件>]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { extractStrings } from './check-copy.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..');
const CJK_RE = /[㐀-鿿]/;
export const ALLOW_COMMENT = 'jargon-allow:';

const TERMS_REL = 'src/renderer/i18n/settingsTerms.json';
const I18N_REL = 'src/renderer/i18n';
const SETTINGS_COMPONENTS_REL = 'src/renderer/components/features/settings';

const toPosix = (v) => v.split(path.sep).join('/');

function termRegex(term) {
  const body = term
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s-]?');
  return new RegExp(`(?<![A-Za-z])${body}(?:s)?(?![A-Za-z])`, 'i');
}

function listScanFiles(root) {
  const files = [];
  const i18nDir = path.join(root, I18N_REL);
  if (fs.existsSync(i18nDir)) {
    for (const name of fs.readdirSync(i18nDir)) {
      if (/^zhSettings.*\.ts$/.test(name) || name === 'onboarding.ts') files.push(path.join(i18nDir, name));
    }
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
        files.push(full);
      }
    }
  };
  const compDir = path.join(root, SETTINGS_COMPONENTS_REL);
  if (fs.existsSync(compDir)) walk(compDir);
  return files.sort();
}

/** 返回 { fileCount, counts: Map<`file\tterm`, {count, samples[]}>, reported: Map<term, n> } */
export function scanSettingsJargon(root = defaultRoot) {
  const table = JSON.parse(fs.readFileSync(path.join(root, TERMS_REL), 'utf-8'));
  const terms = table.terms.map((t) => ({ ...t, re: termRegex(t.term) }));
  const files = listScanFiles(root);
  if (files.length === 0) {
    throw new Error(`[check-settings-jargon] 自检失败：${root} 下匹配 0 个扫描文件，目录结构变了请同步脚本。`);
  }
  const counts = new Map();
  const reported = new Map();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf-8');
    const rawLines = source.split('\n');
    const rel = toPosix(path.relative(root, file));
    for (const str of extractStrings(source)) {
      str.value.split('\n').forEach((segment, offset) => {
        if (!CJK_RE.test(segment)) return;
        const lineNo = str.line + offset;
        if ((rawLines[lineNo - 1] ?? '').includes(ALLOW_COMMENT)) return;
        for (const t of terms) {
          let text = segment.replace(/\{[^{}]*\}/g, '');
          for (const lit of t.allow ?? []) text = text.split(lit).join('');
          if (!t.re.test(text)) continue;
          if (t.mode === 'report') {
            reported.set(t.term, (reported.get(t.term) ?? 0) + 1);
            continue;
          }
          const key = `${rel}\t${t.term}`;
          const cur = counts.get(key) ?? { count: 0, samples: [], human: t.human };
          cur.count++;
          if (cur.samples.length < 5) cur.samples.push(`${rel}:${lineNo}\t${segment.trim().slice(0, 60)}`);
          counts.set(key, cur);
        }
      });
    }
  }
  return { fileCount: files.length, counts, reported };
}

/** 对照 baseline：返回 { failures: string[], tighten: string[] } */
export function compareToBaseline(counts, baseline) {
  const failures = [];
  const tighten = [];
  const entries = new Map();
  for (const e of baseline.entries ?? []) {
    if (!e.reason || !String(e.reason).trim()) failures.push(`baseline 条目缺 reason：${e.file} / ${e.term}`);
    entries.set(`${e.file}\t${e.term}`, e);
  }
  for (const [key, cur] of counts) {
    const [file, term] = key.split('\t');
    const base = entries.get(key);
    const allowed = base ? base.count : 0;
    if (cur.count > allowed) {
      failures.push(
        `${file} 的「${term}」命中 ${cur.count} 处 > 基线 ${allowed}。词表建议写「${cur.human}」（settingsVocabulary.provider/baseUrl/apiKey）。\n` +
          cur.samples.map((s) => `    ${s}`).join('\n'),
      );
    } else if (cur.count < allowed) {
      tighten.push(`${file} 的「${term}」${cur.count} 处 < 基线 ${allowed}，可把 baseline 调小`);
    }
  }
  for (const [key, e] of entries) {
    if (!counts.has(key)) tighten.push(`${e.file} 的「${e.term}」已清零，可删除 baseline 条目`);
  }
  return { failures, tighten };
}

if (process.argv[1] && process.argv[1].endsWith('check-settings-jargon.mjs')) {
  const argv = process.argv.slice(2);
  const argOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = path.resolve(argOf('--root') ?? defaultRoot);
  const baselinePath = path.resolve(argOf('--baseline') ?? path.join(scriptDir, 'settings-jargon-baseline.json'));
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  const { fileCount, counts, reported } = scanSettingsJargon(root);
  const { failures, tighten } = compareToBaseline(counts, baseline);
  console.log(`[check-settings-jargon] 扫描 ${fileCount} 个文件`);
  for (const [term, n] of reported) console.log(`[check-settings-jargon] 报告（不拦）：「${term}」${n} 处`);
  for (const t of tighten) console.log(`[check-settings-jargon] ✓ ${t}`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`[check-settings-jargon] ✗ ${f}`);
    console.error('\n[check-settings-jargon] 设置页中文文案出现英文术语：请改用 settingsVocabulary 里的白话词，禁止新增超出基线的存量。');
    process.exit(1);
  }
  console.log('[check-settings-jargon] ✓ 通过');
}
