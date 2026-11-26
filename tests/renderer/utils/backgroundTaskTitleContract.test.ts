import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Model-written background titles must go through backgroundTaskLabel wherever a ledger task is rendered.
const FILES = [
  'src/renderer/utils/taskRailPresentation.ts',
  'src/renderer/components/features/sidebar/SessionReplaySummaryDialog.tsx',
  'src/renderer/utils/sessionReplayEvidence.ts',
];

describe('background task title contract', () => {
  it.each([
    ...FILES.map((file) => ({ file, bareTitle: /\btask\.title\b/, sharedTitle: /backgroundTaskLabel\(|resumeHint !== task\.title/ })),
    {
      file: 'src/renderer/hooks/useRunWorkbenchModel.ts',
      bareTitle: /displayTitle:.*\btask\.title\b/,
      sharedTitle: /backgroundTaskLabel\(/,
    },
    {
      file: 'src/renderer/hooks/useBackgroundTaskSync.ts',
      bareTitle: /const name =.*\blabel\b/,
      sharedTitle: /backgroundTaskLabel\(/,
    },
    {
      file: 'src/host/task/backgroundTaskSnapshotAdapters.ts',
      bareTitle: /message: buildTerminalMessage\(\{\s*label:.*\bargs\.title\b/,
      sharedTitle: /resolveBackgroundTaskTitle\(/,
    },
  ])('$file has no bare display title', ({ file, bareTitle, sharedTitle }) => {
    const source = readFileSync(file, 'utf8');
    const bare = [...source.matchAll(new RegExp(bareTitle, 'g'))]
      .filter((match) => {
        const lineEnd = source.indexOf('\n', match.index + match[0].length);
        const lineStart = source.lastIndexOf('\n', match.index - 1) + 1;
        return !sharedTitle.test(source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd));
      })
      .map((match) => `${file}:${source.slice(0, match.index).split('\n').length}: ${match[0].trim()}`);
    expect(bare).toEqual([]);
  });
});
