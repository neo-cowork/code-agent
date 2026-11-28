import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/host/session/sessionTitleHostPrompt', () => ({ readUiLanguage: () => ui.language }));

import { buildConfigScopeSummary, handleGetConfigScope } from '../../../src/host/ipc/workspaceConfigScope';
import { toEnglishConfigScope } from '../../../src/host/ipc/workspaceConfigScopeEn';

const HAN = /[㐀-䶿一-鿿豈-﫿]/u;
const SOURCE = path.resolve('src/host/ipc/workspaceConfigScope.ts');
const workDir = mkdtempSync(path.join(tmpdir(), 'config-scope-en-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out));
  return out;
}

/** 源码里每一条中文句子；模板串里的 ${…} 用 3 代入，得到运行时会出现的那句话。 */
function chineseSentencesInSource(): string[] {
  const sourceFile = ts.createSourceFile(SOURCE, readFileSync(SOURCE, 'utf8'), ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && HAN.test(node.text)) {
      found.add(node.text);
    } else if (ts.isTemplateExpression(node)) {
      const rendered = node.head.text + node.templateSpans.map((span) => `3${span.literal.text}`).join('');
      if (HAN.test(rendered)) found.add(rendered);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...found];
}

describe('配置范围摘要的英文文案（FB-1290）', () => {
  it('源码里的每一条中文句子都有英文对应', () => {
    const sentences = chineseSentencesInSource();
    expect(sentences.length).toBeGreaterThan(70);
    const untranslated = sentences.filter((sentence) => HAN.test(toEnglishConfigScope(sentence)));
    expect(untranslated).toEqual([]);
  });

  it('真实摘要整体换成英文后不含中文，结构与路径不变', async () => {
    const zh = await buildConfigScopeSummary(workDir);
    expect(strings(zh).some((text) => HAN.test(text))).toBe(true);
    const en = toEnglishConfigScope(zh);
    expect(strings(en).filter((text) => HAN.test(text))).toEqual([]);
    expect(strings(en).length).toBe(strings(zh).length);
    expect(strings(en).filter((text) => text.includes(workDir)).length)
      .toBe(strings(zh).filter((text) => text.includes(workDir)).length);
    // 没有工作区时的占位同样换掉
    const noWorkspace = toEnglishConfigScope(await buildConfigScopeSummary(null));
    expect(strings(noWorkspace)).toContain('No workspace set');
    expect(strings(noWorkspace).filter((text) => HAN.test(text))).toEqual([]);
  });

  it('IPC 出口：中文界面逐字不变，英文界面不含中文', async () => {
    const direct = await buildConfigScopeSummary(workDir);
    ui.language = 'zh';
    // 两次生成的时间戳不同，比的是全部字符串（每一条显示出来的文字和路径）
    expect(strings(await handleGetConfigScope({ workingDirectory: workDir }, () => null))).toEqual(strings(direct));
    ui.language = 'en';
    const en = await handleGetConfigScope({ workingDirectory: workDir }, () => null);
    expect(strings(en).filter((text) => HAN.test(text))).toEqual([]);
    ui.language = 'zh';
  });

  it('不认识的字符串原样返回；数量句按数字出', () => {
    expect(toEnglishConfigScope('/Users/someone/项目/config.json')).toBe('/Users/someone/项目/config.json');
    expect(toEnglishConfigScope('1 项')).toBe('1 item');
    expect(toEnglishConfigScope('8 项')).toBe('8 items');
    expect(toEnglishConfigScope('发现 2 处疑似凭证或敏感字段。')).toBe('Found 2 possible credential(s) or sensitive field(s).');
  });
});
