import { describe, expect, it } from 'vitest';
import { COMPACTION_SUMMARY } from '../../../src/shared/constants';
import { buildSurvivorManifest } from '../../../src/host/context/survivorManifest';
import { createCompactionPlan } from '../../../src/host/context/compactionService';
import { validateCompactionSummary } from '../../../src/host/context/compactionSummaryValidator';

function readMessage(index: number, name = 'Read', key = 'file_path') {
  return {
    id: `m${index}`,
    role: 'assistant' as const,
    content: 'working',
    timestamp: index,
    toolCalls: [{ id: `c${index}`, name, arguments: { [key]: `/proj/src/file${index}.ts` } }],
  };
}

describe('required-set cap/recency', () => {
  it('marks only the newest MAX_REQUIRED_PATHS touched paths as required', () => {
    const total = COMPACTION_SUMMARY.MAX_REQUIRED_PATHS + 5;
    const messages = Array.from({ length: total }, (_, i) => readMessage(i));
    const manifest = buildSurvivorManifest(messages, { preserveRecentCount: 1 });
    const required = manifest.files.filter((file) => file.required === true).map((file) => file.path);
    expect(required).toHaveLength(COMPACTION_SUMMARY.MAX_REQUIRED_PATHS);
    expect(required).not.toContain('/proj/src/file0.ts');
    expect(required).toContain(`/proj/src/file${total - 1}.ts`);
    expect(manifest.files.find((file) => file.path === '/proj/src/file0.ts')?.required).toBe(false);
  });

  it('counts Edit/Write/NotebookEdit touches and ignores non-file tools', () => {
    const messages = [
      readMessage(0, 'Edit'),
      readMessage(1, 'Write'),
      readMessage(2, 'NotebookEdit', 'notebook_path'),
      readMessage(3, 'Grep', 'path'),
      { id: 'm4', role: 'user' as const, content: 'see /proj/mentioned.md', timestamp: 4 },
    ];
    const manifest = buildSurvivorManifest(messages, { preserveRecentCount: 1 });
    const byPath = new Map(manifest.files.map((file) => [file.path, file.required]));
    expect(byPath.get('/proj/src/file0.ts')).toBe(true);
    expect(byPath.get('/proj/src/file1.ts')).toBe(true);
    expect(byPath.get('/proj/src/file2.ts')).toBe(true);
    expect(byPath.get('/proj/src/file3.ts')).not.toBe(true);
    expect(byPath.get('/proj/mentioned.md')).toBe(false);
  });

  it('validator blocks on missing required paths but only warns for optional ones', () => {
    const manifest = {
      files: [
        { path: '/proj/a.ts', required: true },
        { path: '/proj/b.ts', required: false },
      ],
    };
    const warnOnly = validateCompactionSummary('Touched /proj/a.ts', manifest);
    expect(warnOnly.ok).toBe(true);
    expect(warnOnly.missingPaths).toEqual([]);
    expect(warnOnly.warnings.join('\n')).toContain('/proj/b.ts');

    const blocked = validateCompactionSummary('Touched /proj/b.ts', manifest);
    expect(blocked.ok).toBe(false);
    expect(blocked.missingPaths).toEqual(['/proj/a.ts']);
  });
});

describe('createCompactionPlan', () => {
  it('carries the capped required set and structured errors into the plan manifest', () => {
    const reads = Array.from({ length: COMPACTION_SUMMARY.MAX_REQUIRED_PATHS + 3 }, (_, i) => ({
      ...readMessage(i),
      toolResults: [{ toolCallId: `c${i}`, success: i === 0 ? false : true, error: i === 0 ? 'ENOENT: missing' : undefined, output: 'ok' }],
    }));
    const messages = [
      ...reads,
      { id: 'u', role: 'user' as const, content: 'continue', timestamp: 100 },
      { id: 'a', role: 'assistant' as const, content: 'tail', timestamp: 101 },
    ];
    const plan = createCompactionPlan({
      sessionId: 's', source: 'manual_current', messages, anchorMessageId: 'a', preserveRecentCount: 1,
    });
    expect(plan).not.toBeNull();
    expect(plan?.manifest.files.filter((file) => file.required === true)).toHaveLength(COMPACTION_SUMMARY.MAX_REQUIRED_PATHS);
    expect(plan?.manifest.errors.map((item) => item.text)).toEqual(['ENOENT: missing']);
  });
});

describe('structured error lines', () => {
  it('keeps one deduplicated first line (<=120 chars) per failed tool result', () => {
    const long = `Error: ${'x'.repeat(300)}`;
    const manifest = buildSurvivorManifest(
      [
        {
          id: 'm1',
          role: 'tool' as const,
          content: 'output',
          timestamp: 1,
          toolResults: [
            { toolCallId: 'a', success: false, error: `${long}\nsecond line` },
            { toolCallId: 'b', success: false, error: `${long}\nother tail` },
            { toolCallId: 'c', success: true, output: 'fine', metadata: { exitCode: 2 } },
          ],
        },
      ],
      { preserveRecentCount: 1 },
    );
    expect(manifest.errors).toHaveLength(2);
    expect(manifest.errors[0].text).toHaveLength(COMPACTION_SUMMARY.MAX_ERROR_LINE_CHARS);
    expect(manifest.errors[0].text.startsWith('Error: xxx')).toBe(true);
    expect(manifest.errors[1].text).toBe('fine');
  });

  it('does not treat a prose line mentioning "failed" as an error item', () => {
    const manifest = buildSurvivorManifest(
      [
        { id: 'm1', role: 'assistant' as const, content: 'The earlier attempt failed with a timeout, retrying.', timestamp: 1 },
        {
          id: 'm2',
          role: 'tool' as const,
          content: 'Error: boom happened',
          timestamp: 2,
          toolResults: [{ toolCallId: 'a', success: true, output: 'ok' }],
        },
      ],
      { preserveRecentCount: 1 },
    );
    expect(manifest.errors).toEqual([]);
  });
});

describe('bare label coverage', () => {
  it('does not let a bare "Unresolved error"/"Open work" label cover an item', () => {
    const manifest = {
      errors: [{ label: 'Unresolved error', detail: 'ENOENT: no such file x.ts' }],
      openWork: [{ label: 'Open work', detail: 'TODO: wire the IPC handler' }],
    };
    const bare = validateCompactionSummary('## Unresolved error\n## Open work\nnothing specific', manifest);
    expect(bare.ok).toBe(false);
    expect(bare.missingErrors).toEqual(['Unresolved error: ENOENT: no such file x.ts']);
    expect(bare.missingOpenWork).toEqual(['Open work: TODO: wire the IPC handler']);

    const detailed = validateCompactionSummary('ENOENT: no such file x.ts; TODO: wire the IPC handler', manifest);
    expect(detailed.ok).toBe(true);
  });
});
