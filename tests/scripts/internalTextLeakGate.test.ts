import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateGate,
  loadAndValidateAllowlist,
  loadAndValidateDynamicAllowlist,
  scanRendererStatic,
} from '../../scripts/internal-text-leak-gate.mjs';

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
