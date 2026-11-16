import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scriptPath = resolve('scripts/ci/renderer-zh-default-ratchet.mjs');

describe('renderer-zh-default-ratchet', () => {
  let repoRoot: string;
  let baselinePath: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'renderer-zh-default-ratchet-'));
    mkdirSync(join(repoRoot, 'src/renderer/components'), { recursive: true });
    mkdirSync(join(repoRoot, 'src/renderer/i18n'), { recursive: true });
    mkdirSync(join(repoRoot, 'scripts/ci'), { recursive: true });
    baselinePath = join(repoRoot, 'scripts/ci/renderer-zh-default-baseline.json');
    writeFileSync(baselinePath, '{"schemaVersion":1,"files":{}}\n');
  });

  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  function run(...args: string[]) {
    return spawnSync(process.execPath, [scriptPath, '--repo-root', repoRoot, ...args], { encoding: 'utf8' });
  }

  it('passes an empty baseline when no renderer helper defaults to Chinese', () => {
    writeFileSync(join(repoRoot, 'src/renderer/components/ok.ts'), 'export const ok = (language: "zh" | "en") => language;\n');
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('targets=0 baseline=0');
  });

  it('reports language defaults, ZH pack defaults, and zh nullish fallbacks outside i18n', () => {
    writeFileSync(join(repoRoot, 'src/renderer/components/bad.tsx'), [
      'declare const zh: { label: string };',
      'declare const ZH_PANEL_TEXT: object;',
      'export function bad(lang: "zh" | "en" = "zh", text: object = ZH_PANEL_TEXT, locale: string = "zh") {',
      '  return <div title={text ?? ZH_PANEL_TEXT}>{lang ?? zh.label}{locale}</div>;',
      '}',
    ].join('\n'));
    writeFileSync(join(repoRoot, 'src/renderer/i18n/allowed.ts'), 'export const x = (lang = "zh") => lang;\n');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('New default-to-zh fallback detected');
    expect(result.stdout).toContain('[zh-language-default]');
    expect(result.stdout).toContain('[zh-pack-default]');
    expect(result.stdout).toContain('[zh-nullish-fallback]');
    expect(result.stdout).toContain('[zh-pack-nullish-fallback]');
    expect(result.stdout).not.toContain('i18n/allowed.ts');
  });

  it('only tightens an existing baseline', () => {
    const source = join(repoRoot, 'src/renderer/components/existing.ts');
    writeFileSync(source, 'export const f = (language = "zh") => language;\n');
    writeFileSync(baselinePath, JSON.stringify({ schemaVersion: 1, files: { 'src/renderer/components/existing.ts': { count: 1, kinds: { 'zh-language-default': 1 } } } }));
    expect(run().status).toBe(0);
    writeFileSync(source, 'export const f = (language: string) => language;\n');
    expect(run().status).toBe(1);
    expect(run('--update-baseline').status).toBe(0);
    expect(JSON.parse(readFileSync(baselinePath, 'utf8')).files).toEqual({});
  });
});
