import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 设置页英文术语门（scripts/ci/check-settings-jargon.mjs）。只走脚本公开入口：CLI 子进程。
// 违例样本用拼接构造（门不扫 tests，但别让规则文本匹配到自己）。
const REPO = resolve(__dirname, '../..');
const SCRIPT = join(REPO, 'scripts/ci/check-settings-jargon.mjs');
const TERMS = join(REPO, 'src/renderer/i18n/settingsTerms.json');
const PROV = 'Pro' + 'vider';
const KEY = 'API ' + 'Key';

function run(args: string[]) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('check-settings-jargon', () => {
  let root: string;
  let baseline: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jargon-gate-'));
    mkdirSync(join(root, 'src/renderer/i18n'), { recursive: true });
    cpSync(TERMS, join(root, 'src/renderer/i18n/settingsTerms.json'));
    baseline = join(root, 'baseline.json');
    writeFileSync(baseline, JSON.stringify({ entries: [] }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const fixture = (body: string) => writeFileSync(join(root, 'src/renderer/i18n/zhSettingsFake.ts'), body);

  it('红→绿：违规 zh 串报出文件与词；删掉后通过', () => {
    fixture(`export const a = { t: '新增 ${PROV}' };\n`);
    const red = run(['--root', root, '--baseline', baseline]);
    expect(red.code).toBe(1);
    expect(red.out).toContain('zhSettingsFake.ts');
    expect(red.out).toContain('Provider');
    expect(red.out).toContain('模型服务');
    fixture(`export const a = { t: '新增模型服务' };\n`);
    expect(run(['--root', root, '--baseline', baseline]).code).toBe(0);
  });

  it('不含中文的串、{占位符}、/v1、注释、行内豁免都不误报', () => {
    fixture([
      `// 注释里写 ${PROV} 不算`,
      `export const a = { en: 'Add ${PROV}', ph: '已连接 {provider}', ok: '填到 /v1 结尾', ex: '中文 ${KEY}', // jargon-allow: 品牌原文`,
      '};',
      '',
    ].join('\n'));
    expect(run(['--root', root, '--baseline', baseline]).code).toBe(0);
  });

  it('report 模式（MCP）只列出不拦', () => {
    fixture(`export const a = { t: '管理 MCP 服务' };\n`);
    const r = run(['--root', root, '--baseline', baseline]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('MCP');
  });

  it('门与词表同源：改词表（加新 enforce 词）立刻被门读到', () => {
    fixture(`export const a = { t: '打开 Gateway 设置' };\n`);
    expect(run(['--root', root, '--baseline', baseline]).code).toBe(0);
    const p = join(root, 'src/renderer/i18n/settingsTerms.json');
    const t = JSON.parse(readFileSync(p, 'utf-8'));
    t.terms.push({ id: 'gateway', term: 'Gateway', human: '网关', mode: 'enforce', allow: [] });
    writeFileSync(p, JSON.stringify(t));
    const r = run(['--root', root, '--baseline', baseline]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Gateway');
    // 渲染端词汇模块读的也是这个文件
    expect(readFileSync(join(REPO, 'src/renderer/i18n/settingsVocabulary.ts'), 'utf-8')).toContain("./settingsTerms.json");
  });

  it('基线：存量内放行，超出即红，条目缺 reason 即红', () => {
    fixture(`export const a = { t: '新增 ${PROV}', u: '搜索 ${PROV}' };\n`);
    const entry = { file: 'src/renderer/i18n/zhSettingsFake.ts', term: 'Provider', count: 2, reason: 'unowned stock' };
    writeFileSync(baseline, JSON.stringify({ entries: [entry] }));
    expect(run(['--root', root, '--baseline', baseline]).code).toBe(0);
    writeFileSync(baseline, JSON.stringify({ entries: [{ ...entry, count: 1 }] }));
    expect(run(['--root', root, '--baseline', baseline]).code).toBe(1);
    writeFileSync(baseline, JSON.stringify({ entries: [{ ...entry, reason: '' }] }));
    expect(run(['--root', root, '--baseline', baseline]).out).toContain('缺 reason');
  });

  it('真实仓库：提交的基线条目都有 reason，且命中数不超过基线（只降不升）', () => {
    const base = JSON.parse(readFileSync(join(REPO, 'scripts/ci/settings-jargon-baseline.json'), 'utf-8'));
    for (const e of base.entries) {
      expect(String(e.reason).trim().length, `${e.file} ${e.term}`).toBeGreaterThan(0);
      expect(Number.isInteger(e.count) && e.count > 0).toBe(true);
    }
    const r = run([]);
    expect(r.out).not.toContain('✗');
    expect(r.code).toBe(0);
  });
});
