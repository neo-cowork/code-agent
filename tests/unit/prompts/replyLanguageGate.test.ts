// ============================================================================
// 门：src/host/prompts 下不许再硬编码「回复语言」指令
// ============================================================================
// 回复语言只能由 communication.ts 的 <reply_language> 指令按 ui.language 决定。
// 任何别处写死「用中文沟通 / Reply in English」都会和它互相打架（FB-1513：模板里一行
// 「用中文沟通」就是这种矛盾）。新增命中必须进白名单并写明理由。
// ============================================================================

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PROMPTS_DIR = path.resolve(__dirname, '../../../src/host/prompts');

const LANGUAGE_INSTRUCTION =
  /用中文|中文回[复答]|用英文|英文回[复答]|(reply|respond|answer|write) in (chinese|english)/i;

const ALLOWLIST: Array<{ file: string; contains: string; reason: string }> = [
  {
    file: 'communication.ts',
    contains: 'Reply in English by default',
    reason: '唯一的回复语言指令（en 才下发，zh 为空串）',
  },
  {
    file: 'soulLoader.ts',
    contains: '用中文沟通',
    reason: '旧模板遗留句的识别字面量，加载期在 en 下被替换，不是下发给模型的指令',
  },
  {
    file: 'questionForm.ts',
    contains: '禁用英文标题',
    reason: '提问表单 constraints 的示例文案，不是回复语言指令',
  },
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|md)$/.test(entry.name) ? [full] : [];
  });
}

describe('prompts 目录不硬编码回复语言指令', () => {
  it('扫描面有效：确实读到了 prompts 文件', () => {
    expect(walk(PROMPTS_DIR).length).toBeGreaterThan(10);
  });

  it('白名单每项都仍然命中（防止白名单腐烂）', () => {
    for (const item of ALLOWLIST) {
      const text = fs.readFileSync(path.join(PROMPTS_DIR, item.file), 'utf-8');
      expect(text, `${item.file} 不再含 ${item.contains}，删掉这条白名单`).toContain(item.contains);
      expect(item.reason.length).toBeGreaterThan(5);
    }
  });

  it('除白名单外没有任何回复语言指令', () => {
    const violations: string[] = [];
    for (const file of walk(PROMPTS_DIR)) {
      const rel = path.relative(PROMPTS_DIR, file);
      fs.readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        if (!LANGUAGE_INSTRUCTION.test(line)) return;
        const allowed = ALLOWLIST.some((a) => rel === a.file && line.includes(a.contains));
        if (!allowed) violations.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(violations, `硬编码回复语言指令（只许 communication.ts 决定）:\n${violations.join('\n')}`).toEqual([]);
  });
});
