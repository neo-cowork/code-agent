import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// N-FIX-COMPOSER-RAW-MODEL-ID-NEOHORSE-REST1：StatusBar 与 ChatInput 里凡是把模型 id
// 塞进用户可见文案的 `.replace('{model}'|'{original}'|'{shown}'|'{baseline}'|'{modelId}', …)`
// 第二参必须经过 getModelDisplayLabel / getRuntimeModelLabel，禁止裸 id 外露。
//
// 刻意不匹配的形态：ModelSwitcher 下拉副标题的 JSX `{opt.model}`（不是 .replace 调用）
// 按产品决定保留裸 id——见任务书「Deliberately raw and to stay raw」。

const here = dirname(fileURLToPath(import.meta.url));
const SCAN_ROOTS = [
  resolve(here, '../../../src/renderer/components/StatusBar'),
  resolve(here, '../../../src/renderer/components/features/chat/ChatInput'),
];

// 白名单：文件 + 精确源码锚文本 + 一行理由。锚文本在文件里消失时下方测试会红（防白名单腐化）。
const ALLOWLIST = [
  {
    file: 'SlashCommandPopover.tsx',
    needle: 'modelSwitchHint',
    reason: '/model 诊断读出（开发者向），刻意显示裸 id',
  },
  {
    file: 'SlashCommandPopover.tsx',
    needle: 'configModel',
    reason: '/config 诊断读出（开发者向），刻意显示裸 id',
  },
] as const;

interface Violation {
  file: string;
  line: number;
  placeholder: string;
  expr: string;
  lineText: string;
}

const PLACEHOLDER_KEYS = ['model', 'original', 'shown', 'baseline', 'modelId'] as const;
const CALL_START_RE = new RegExp(
  `\\.replace\\(\\s*'\\{(?:${PLACEHOLDER_KEYS.join('|')})\\}'\\s*,`,
  'g',
);

/** 从第二个参数起始处扫描到 replace( 的配对右括号，跳过字符串字面量与嵌套括号。 */
function extractSecondArgument(source: string, argStart: number): string {
  let depth = 1; // 已经处于 replace( 的括号内
  let i = argStart;
  let expr = '';
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      expr += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          expr += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        expr += source[i];
        i += 1;
        if (expr.at(-1) === quote) break;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
    expr += ch;
    i += 1;
  }
  return expr.trim();
}

function scanSource(relPath: string, source: string): Violation[] {
  const violations: Violation[] = [];
  for (const match of source.matchAll(CALL_START_RE)) {
    const index = match.index ?? 0;
    const expr = extractSecondArgument(source, index + match[0].length);
    if (/getModelDisplayLabel|getRuntimeModelLabel/.test(expr)) continue;
    const line = source.slice(0, index).split('\n').length;
    violations.push({
      file: relPath,
      line,
      placeholder: match[1],
      expr,
      lineText: source.split('\n')[line - 1].trim(),
    });
  }
  return violations;
}

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listTsFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('model id placeholder copy gate (N-FIX-COMPOSER-RAW-MODEL-ID-NEOHORSE-REST1)', () => {
  it('scanner self-test: raw id insert is flagged, label-wrapped insert is clean', () => {
    // 裸 id → 打红
    expect(scanSource('synthetic/CostDisplay.tsx', "t.turnCostLine.replace('{model}', lastTurnCost.modelId)"))
      .toHaveLength(1);
    expect(scanSource('synthetic/ModelSwitcher.tsx', "title.replace('{baseline}', PRICING_BASELINE_DEFAULT.modelId)"))
      .toHaveLength(1);
    // 包上标签表 → 干净（嵌套括号正确跳过）
    expect(scanSource('synthetic/CostDisplay.tsx', "t.turnCostLine.replace('{model}', getModelDisplayLabel(lastTurnCost.modelId))"))
      .toEqual([]);
    expect(scanSource('synthetic/modelSwitcherTooltips.ts', "labels.model.replace('{model}', getRuntimeModelLabel(m, p, s))"))
      .toEqual([]);
    // JSX 副标题 {opt.model} 不是 .replace 调用，模式刻意不匹配（下拉副标题保留裸 id 是产品决定）
    expect(scanSource('synthetic/ModelSwitcher.tsx', '<span className="text-gray-500">{opt.model}</span>'))
      .toEqual([]);
    // 非模型占位符不管
    expect(scanSource('synthetic/CostDisplay.tsx', "t.budgetUsageTitle.replace('{cost}', '$0.50')"))
      .toEqual([]);
  });

  it('StatusBar 与 ChatInput 的模型占位符替换一律走标签表（白名单除外）', () => {
    const files = SCAN_ROOTS.flatMap((root) => listTsFiles(root));
    expect(files.length).toBeGreaterThan(0);

    const usedAllowlist = new Set<string>();
    const offenders: Violation[] = [];
    for (const file of files) {
      const relPath = file.slice(file.indexOf('src/renderer/'));
      const source = readFileSync(file, 'utf8');
      for (const violation of scanSource(relPath, source)) {
        const allowEntry = ALLOWLIST.find(
          (entry) => entry.file === basename(file) && violation.lineText.includes(entry.needle),
        );
        if (allowEntry) {
          usedAllowlist.add(`${allowEntry.file}:${allowEntry.needle}`);
          continue;
        }
        offenders.push(violation);
      }
    }

    expect(
      offenders,
      '模型 id 被裸塞进用户可见文案：请用 getModelDisplayLabel / getRuntimeModelLabel 包住第二参，或在 ALLOWLIST 里显式登记理由',
    ).toEqual([]);

    // 白名单不许腐化：每条都必须还在源码里被实际命中
    expect([...usedAllowlist].sort()).toEqual(
      [...ALLOWLIST].map((entry) => `${entry.file}:${entry.needle}`).sort(),
    );
  });
});
