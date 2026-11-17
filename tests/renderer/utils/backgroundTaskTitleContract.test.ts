import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Model-written background titles must go through backgroundTaskLabel wherever a ledger task is rendered.
const FILES = [
  'src/renderer/utils/taskRailPresentation.ts',
  'src/renderer/components/features/sidebar/SessionReplaySummaryDialog.tsx',
  'src/renderer/utils/sessionReplayEvidence.ts',
];

describe('background task title contract', () => {
  it.each(FILES)('%s has no bare task.title render', (file) => {
    const lines = readFileSync(file, 'utf8').split('\n');
    const bare = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\btask\.title\b/.test(line) && !/backgroundTaskLabel\(/.test(line)
        && !/resumeHint !== task\.title/.test(line));
    expect(bare.map(({ n, line }) => `${file}:${n}: ${line.trim()}`)).toEqual([]);
  });
});
