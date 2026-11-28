// ============================================================================
// 绝对路径展示门：renderer 里不许再把裸路径字段直接塞进 title={…} 或 JSX 文本。
// 展示一律走 formatPathForDisplay（或 formatDisplayPath / getCollisionHoverTitles）；
// 用户要真路径靠「在访达中显示」之类动作，不靠悬停露出 /Users/<账户>。
// 存量记在 absolutePathDisplayBaseline.json（每条带理由）：
// 超出基线 → 失败；低于基线 → 也失败（说明已修，必须同步收紧基线）；基线只降不升。
// ============================================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const RENDERER_ROOT = path.resolve(__dirname, '../../src/renderer');
const BASELINE_PATH = path.resolve(__dirname, 'absolutePathDisplayBaseline.json');

// 末段像路径字段；以 i18n 文案对象（t / copy / xxxText …）为根的不算。
const TERMINAL = /^\w*(?:[pP]ath|[dD]ir|[dD]irectory|[fF]older)$/;
const COPY_ROOT = /^(?:t|copy|text|labels|rm|ps|cc|\w+Text|\w+Copy|\w+Labels)$/;

function isRawPathExpression(expression: string): boolean {
  const segments = expression.trim().split('.').map((s) => s.replace(/[?!]/g, ''));
  if (!segments.every((s) => /^\w+$/.test(s))) return false; // 函数调用（formatPathForDisplay(...) 等）不算裸路径
  if (!TERMINAL.test(segments[segments.length - 1])) return false;
  return !(segments.length > 1 && COPY_ROOT.test(segments[0]));
}

function countRawPathDisplays(source: string): number {
  let count = 0;
  for (const m of source.matchAll(/\btitle=\{([^{}]*)\}/g)) if (isRawPathExpression(m[1])) count++;
  for (const m of source.matchAll(/>\s*\{([\w.?!]+)\}\s*</g)) if (isRawPathExpression(m[1])) count++;
  for (const m of source.matchAll(/^\s*\{([\w.?!]+)\}\s*$/gm)) if (isRawPathExpression(m[1])) count++;
  return count;
}

function collectTsx(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsx(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

type Baseline = Record<string, { count: number; reason: string }>;

describe('绝对路径展示门', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  const actual: Record<string, number> = {};
  for (const file of collectTsx(RENDERER_ROOT)) {
    const n = countRawPathDisplays(fs.readFileSync(file, 'utf8'));
    if (n > 0) actual[path.relative(path.resolve(__dirname, '../..'), file)] = n;
  }

  it('扫描器认得 title / 文本里的裸路径字段，放过包了展示函数的写法', () => {
    expect(countRawPathDisplays('<span title={source.path}>{source.path}</span>')).toBe(2);
    expect(countRawPathDisplays('<div title={workingDirectory} />')).toBe(1);
    expect(countRawPathDisplays('<span title={formatPathForDisplay(source.path)}>{formatPathForDisplay(source.path)}</span>')).toBe(0);
    expect(countRawPathDisplays('<span title={copy.addFolder}>{t.lab.recommendedPath}</span>')).toBe(0);
  });

  it('每条存量都有非空理由，且文件真实存在', () => {
    for (const [file, entry] of Object.entries(baseline)) {
      expect(entry.reason.trim().length, `${file} 缺理由`).toBeGreaterThan(0);
      expect(entry.count, `${file} 基线计数必须为正`).toBeGreaterThan(0);
      expect(fs.existsSync(path.resolve(__dirname, '../..', file)), `${file} 已不存在，删掉这条基线`).toBe(true);
    }
  });

  it('没有新增裸路径展示（超出基线即失败）', () => {
    const over = Object.entries(actual)
      .filter(([file, n]) => n > (baseline[file]?.count ?? 0))
      .map(([file, n]) => `${file}: ${n} > 基线 ${baseline[file]?.count ?? 0}（用 formatPathForDisplay 包起来）`);
    expect(over).toEqual([]);
  });

  it('基线没有过期（修掉了就必须收紧基线）', () => {
    const stale = Object.entries(baseline)
      .filter(([file, entry]) => (actual[file] ?? 0) < entry.count)
      .map(([file, entry]) => `${file}: 基线 ${entry.count} > 实际 ${actual[file] ?? 0}（把基线降到实际值或删掉）`);
    expect(stale).toEqual([]);
  });
});
