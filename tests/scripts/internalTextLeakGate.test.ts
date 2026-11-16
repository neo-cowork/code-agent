import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectStaticStringLeaks,
  evaluateGate,
  loadAndValidateAllowlist,
  loadAndValidateDynamicAllowlist,
  scanRendererStatic,
} from '../../scripts/ci/internal-text-leak-gate.mjs';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-leak-gate-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('internal-text-leak-gate', () => {
  it('shares catalog and explicit render-language rules with the dynamic detector', () => {
    expect(detectStaticStringLeaks('Used weekly-report-synthesis')).toContain('catalog_slug');
    expect(detectStaticStringLeaks('Used my-custom-skill')).toEqual([]);
    expect(detectStaticStringLeaks('Report 已完成', 'en')).toContain('cjk_in_en_ui');
    expect(detectStaticStringLeaks('Report ready', 'en')).toEqual([]);
    expect(detectStaticStringLeaks('已完成', 'zh')).toEqual([]);
  });
  it('keeps the real renderer and explicit host copy roots clean', () => {
    const result = evaluateGate();
    expect(result.hostCopyRoots).toEqual([
      'src/shared/i18n',
      'src/shared/constants/backgroundTaskPreannounce.ts',
      'src/host/services/sessionAutomation/sessionAutomationService.ts',
      'src/host/agent/runtime/contextAssembly/sessionCommandCenterPreannounce.ts',
    ]);
    expect(result.hostCopyFilesScanned).toBeGreaterThan(3);
    expect(result.unexpectedHits).toEqual([]);
  });

  it.each([
    ['src/host/services/sessionAutomation/sessionAutomationService.ts', 'lines.push(`结果会话：${input.resultSessionId}`);', 'raw_id_interpolation'],
    ['src/shared/i18n/sessionTaskSlot.ts', 'const detail = (laneKey: string) => `任务在 lane「${laneKey}」占用 2 小时后仍未收到终态事件`;', 'raw_id_interpolation'],
    ['src/host/agent/runtime/contextAssembly/sessionCommandCenterPreannounce.ts', 'const preview = "我先把“<repeated_workarounds> 以下是你在…”交给后台执行";', 'injected_prompt'],
    ['src/shared/constants/backgroundTaskPreannounce.ts', 'const generic = "session_1793000000000";', 'session_id'],
  ])('is RED for old copy in %s (%s)', (file, source, rule) => {
    const dir = createTempDir();
    const rendererDir = path.join(dir, 'src/renderer');
    fs.mkdirSync(rendererDir, { recursive: true });
    fs.writeFileSync(path.join(rendererDir, 'Clean.tsx'), 'export const Clean = () => <p>Ready</p>;');
    const hostFile = path.join(dir, file);
    fs.mkdirSync(path.dirname(hostFile), { recursive: true });
    fs.writeFileSync(hostFile, source);
    const allowlistPath = path.join(dir, 'allowlist.json');
    fs.writeFileSync(allowlistPath, '[]');
    const result = evaluateGate({ rendererDir, repoRoot: dir, allowlistPath });
    expect(result.hostCopyFilesScanned).toBe(1);
    expect(result.unexpectedHits).toContainEqual(expect.objectContaining({ file, rule }));
  });

  it.each(['sessionId', 'sourceSessionId', 'resultSessionId', 'runId', 'taskId', 'laneKey'])('catches interpolated identifiers and members named %s', (name) => {
    const dir = createTempDir();
    const rendererDir = path.join(dir, 'src/renderer');
    const hostDir = path.join(dir, 'src/shared/i18n');
    fs.mkdirSync(rendererDir, { recursive: true });
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(rendererDir, 'Clean.tsx'), 'export const Clean = () => <p>Ready</p>;');
    fs.writeFileSync(path.join(hostDir, 'copy.ts'), 'const a = `Result ${' + name + '}`; const b = `Result ${input.' + name + '}`;');
    expect(scanRendererStatic({ rendererDir, repoRoot: dir }).hits.filter((hit: { rule: string }) => hit.rule === 'raw_id_interpolation')).toHaveLength(2);
  });

  it('does not scan general host prompts or SQL and tool discriminators as copy', () => {
    const dir = createTempDir();
    const rendererDir = path.join(dir, 'src/renderer');
    const hostDir = path.join(dir, 'src/host/services/sessionAutomation');
    fs.mkdirSync(rendererDir, { recursive: true });
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(rendererDir, 'Clean.tsx'), 'export const Clean = () => <p>Ready</p>;');
    fs.writeFileSync(path.join(hostDir, 'sessionAutomationService.ts'), 'db.prepare("SELECT * FROM session_automations"); const isDelegate = input.toolName === "delegate_task";');
    fs.writeFileSync(path.join(hostDir, 'unscannedPrompt.ts'), 'const prompt = "<system-context>session_123</system-context>";');
    expect(scanRendererStatic({ rendererDir, repoRoot: dir }).hits).toEqual([]);
  });

  it('requires a reason for the new host rule and can allowlist an exact non-display key', () => {
    const dir = createTempDir();
    const file = path.join(dir, 'allowlist.json');
    const entry = { file: 'src/shared/i18n/copy.ts', rule: 'raw_id_interpolation', sample: '`key:${taskId}`', reason: '' };
    fs.writeFileSync(file, JSON.stringify([entry]));
    expect(() => loadAndValidateAllowlist(file)).toThrow(/missing a non-empty "reason"/);
    fs.writeFileSync(file, JSON.stringify([{ ...entry, reason: 'Non-display storage key' }]));
    expect(loadAndValidateAllowlist(file)).toHaveLength(1);
  });

  it('fails loud when the allowlist contains an entry with an empty or missing reason', () => {
    const dir = createTempDir();
    const allowlistPath = path.join(dir, 'allowlist.json');
    fs.writeFileSync(
      allowlistPath,
      JSON.stringify([
        {
          file: 'src/renderer/Foo.tsx',
          rule: 'session_id',
          sample: '`session_${id}`',
          reason: '   ',
        },
      ]),
      'utf8',
    );

    expect(() => loadAndValidateAllowlist(allowlistPath)).toThrow(
      /missing a non-empty "reason"/,
    );
  });

  it('fails loud when 0 renderer files are scanned', () => {
    const dir = createTempDir();
    expect(() =>
      scanRendererStatic({ rendererDir: dir, repoRoot: dir }),
    ).toThrow(/0 files scanned/);
  });

  it('fails loud when a renderer file has a TypeScript syntax/parse error', () => {
    const dir = createTempDir();
    const file = path.join(dir, 'Broken.tsx');
    fs.writeFileSync(file, 'export const Broken = () => <div><span>unclosed;', 'utf8');

    expect(() =>
      scanRendererStatic({ rendererDir: dir, repoRoot: dir }),
    ).toThrow(/TypeScript parse error/);
  });

  it('catches deliberate leaking literals (`session_${id}` and "interrupted: process crashed") and reports file + rule', () => {
    const dir = createTempDir();
    const rendererDir = path.join(dir, 'src/renderer');
    fs.mkdirSync(rendererDir, { recursive: true });
    const compFile = path.join(rendererDir, 'LeakDemo.tsx');
    fs.writeFileSync(
      compFile,
      [
        'import React from "react";',
        'export function LeakDemo({ id }: { id: string }) {',
        '  return (',
        '    <div>',
        '      <span>{`session_${id}`}</span>',
        '      <p>{"interrupted: process crashed"}</p>',
        '    </div>',
        '  );',
        '}',
      ].join('\n'),
      'utf8',
    );

    const allowlistPath = path.join(dir, 'allowlist.json');
    fs.writeFileSync(allowlistPath, '[]', 'utf8');

    const result = evaluateGate({
      rendererDir,
      allowlistPath,
      repoRoot: dir,
    });

    expect(result.filesScanned).toBe(1);
    expect(result.unexpectedHits).toEqual([
      expect.objectContaining({
        file: 'src/renderer/LeakDemo.tsx',
        rule: 'session_id',
        sample: '{`session_${id}`}',
      }),
      expect.objectContaining({
        file: 'src/renderer/LeakDemo.tsx',
        rule: 'english_state_word',
        sample: '{"interrupted: process crashed"}',
      }),
    ]);
  });

  it('catches a newly named runtime identifier member such as `{job.id}`', () => {
    const dir = createTempDir();
    const rendererDir = path.join(dir, 'src/renderer');
    fs.mkdirSync(rendererDir, { recursive: true });
    fs.writeFileSync(
      path.join(rendererDir, 'RuntimeIdLeak.tsx'),
      'export function RuntimeIdLeak({ job }: { job: { id: string } }) { return <span>{job.id}</span>; }\n',
      'utf8',
    );
    const allowlistPath = path.join(dir, 'allowlist.json');
    fs.writeFileSync(allowlistPath, '[]', 'utf8');

    const result = evaluateGate({ rendererDir, allowlistPath, repoRoot: dir });

    expect(result.unexpectedHits).toEqual([
      expect.objectContaining({
        file: 'src/renderer/RuntimeIdLeak.tsx',
        rule: 'uuid',
        sample: '{job.id}',
      }),
    ]);
  });

  it('fails loud when a dynamic expected-leak entry has no reason', () => {
    const dir = createTempDir();
    const allowlistPath = path.join(dir, 'dynamic-allowlist.json');
    fs.writeFileSync(
      allowlistPath,
      JSON.stringify([
        { file: 'error-card', rule: 'session_id', sample: 'session_x', reason: '' },
      ]),
      'utf8',
    );

    expect(() => loadAndValidateDynamicAllowlist(allowlistPath)).toThrow(
      /missing a non-empty "reason"/,
    );
  });

  it('reports stale allowlist entries without failing when an allowlisted leak is fixed', () => {
    const dir = createTempDir();
    const rendererDir = path.join(dir, 'src/renderer');
    fs.mkdirSync(rendererDir, { recursive: true });
    fs.writeFileSync(
      path.join(rendererDir, 'Clean.tsx'),
      'import React from "react";\nexport const Clean = () => <div>一切正常</div>;\n',
      'utf8',
    );

    const allowlistPath = path.join(dir, 'allowlist.json');
    fs.writeFileSync(
      allowlistPath,
      JSON.stringify([
        {
          file: 'src/renderer/Clean.tsx',
          rule: 'uuid',
          sample: '{execution.id}',
          reason: 'N-FIX-CRON-RUN-RAW-ID-AS-NAME',
        },
      ]),
      'utf8',
    );

    const result = evaluateGate({
      rendererDir,
      allowlistPath,
      repoRoot: dir,
    });

    expect(result.unexpectedHits).toEqual([]);
    expect(result.staleEntries).toHaveLength(1);
    expect(result.staleEntries[0]?.reason).toBe('N-FIX-CRON-RUN-RAW-ID-AS-NAME');
  });
});
