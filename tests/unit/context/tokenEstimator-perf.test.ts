// ============================================================================
// Token Estimator & Survivor Manifest Long-Input Performance Tests
// ============================================================================

import { describe, expect, it } from 'vitest';
import { analyzeContent, estimateTokens } from '../../../src/host/context/tokenEstimator';
import { buildSurvivorManifest, type SurvivorManifestMessage } from '../../../src/host/context/survivorManifest';

function buildSingleLineManifestJson(targetChars = 411_000): string {
  const commands = [];
  let index = 0;
  while (true) {
    commands.push({
      messageId: `msg-${index}`,
      command: `npx vitest run tests/unit/context/file-${index}.test.ts`,
      cwd: `/workspace/src/mod-${index % 12}`,
      exitCode: index % 5 === 0 ? 1 : 0,
      success: index % 5 !== 0,
      stdoutSummary: `[info] [step-${index}] [pass] [1/4] [2/4] [3/4] [4/4] array=[1,2,3] [done] [ok]`,
      stderrSummary: `[stderr] [warn] [trace-${index}] [frame-0] [frame-1] [frame-2]`,
    });
    index += 1;
    if (index % 20 === 0) {
      const serialized = JSON.stringify({
        sessionId: 'sess-perf-411k',
        source: 'auto_threshold',
        preserveRecentCount: 6,
        compactedMessageIds: Array.from({ length: 120 }, (_, k) => `m-${k}`),
        preservedMessageIds: ['m-120', 'm-121', 'm-122'],
        filePaths: Array.from({ length: 80 }, (_, k) => `/workspace/src/file-${k}.ts`),
        commands,
      });
      if (serialized.length >= targetChars) return serialized;
    }
  }
}

function buildLargeSessionMessages(count = 400): SurvivorManifestMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    role: 'assistant' as const,
    content: `Step ${index} inspected /workspace/src/mod-${index % 30}/file-${index}.ts\nTODO: verify item [${index}]`,
    toolCalls: [
      {
        id: `call-${index}`,
        name: 'bash',
        arguments: {
          command: `npm test -- file-${index}`,
          cwd: '/workspace',
        },
      },
    ],
    toolResults: [
      {
        toolCallId: `call-${index}`,
        success: index % 4 !== 0,
        output: `[stdout] [step-${index}] [1/3] [2/3] [3/3] ${'x'.repeat(390)}`,
        error: index % 4 === 0 ? `Error: failed [${index}] ${'e'.repeat(150)}` : undefined,
        metadata: { exitCode: index % 4 === 0 ? 1 : 0 },
      },
    ],
  }));
}

describe('tokenEstimator long-text regex bounds', () => {
  it(
    'estimates ~411k-char single-line compact JSON under bound without quadratic link scan',
    () => {
      const compactJson = buildSingleLineManifestJson(411_000);
      expect(compactJson.length).toBeGreaterThanOrEqual(411_000);
      expect(compactJson.includes('\n')).toBe(false);

      const started = performance.now();
      const tokens = estimateTokens(compactJson);
      const elapsedMs = performance.now() - started;

      expect(tokens).toBeGreaterThan(100_000);
      expect(elapsedMs).toBeLessThan(1500);
    },
    20_000,
  );

  it(
    'estimates many-[ without ]( and blank-line runs at ~411k chars under bound',
    () => {
      const manyOpenBrackets = `${'[segment,'.repeat(45_700)}tail-${Date.now()}`;
      expect(manyOpenBrackets.length).toBeGreaterThanOrEqual(411_000);

      const startedBrackets = performance.now();
      const bracketTokens = estimateTokens(manyOpenBrackets);
      const bracketElapsedMs = performance.now() - startedBrackets;

      expect(bracketTokens).toBeGreaterThan(100_000);
      expect(bracketElapsedMs).toBeLessThan(1500);

      const blankLineRun = `${'\n   \t  '.repeat(58_800)}end`;
      const startedBlanks = performance.now();
      const blankTokens = estimateTokens(blankLineRun);
      const blankElapsedMs = performance.now() - startedBlanks;

      expect(blankTokens).toBeGreaterThan(50_000);
      expect(blankElapsedMs).toBeLessThan(1500);
    },
    20_000,
  );

  it(
    'budgets a ~411k-char survivor manifest through buildSurvivorManifest(maxTokens) under bound',
    () => {
      const messages = buildLargeSessionMessages(400);
      const unbudgeted = buildSurvivorManifest(messages, {
        sessionId: 'sess-manifest-411k',
        preserveRecentCount: 5,
        maxItemChars: 900,
      });
      expect(JSON.stringify(unbudgeted).length).toBeGreaterThanOrEqual(411_000);

      const started = performance.now();
      const budgeted = buildSurvivorManifest(messages, {
        sessionId: 'sess-manifest-411k',
        preserveRecentCount: 5,
        maxItemChars: 900,
        maxTokens: 8000,
      });
      const elapsedMs = performance.now() - started;

      expect(estimateTokens(JSON.stringify(budgeted))).toBeLessThanOrEqual(8000);
      expect(budgeted.commands.length).toBeLessThan(unbudgeted.commands.length);
      expect(elapsedMs).toBeLessThan(2000);
    },
    20_000,
  );

  it('still classifies ordinary markdown links, bold, and lists as markdown', () => {
    const linksOnly = [
      'Please review the [Getting Started Guide](docs-start) before making any updates to the release workflow or team schedule',
      'Also consult the ![Architecture Diagram](docs-arch) and the [Release Checklist](docs-checklist) when preparing notes for the review meeting',
    ].join('\n');
    expect(analyzeContent(linksOnly).primaryType).toBe('markdown');

    const boldAndLists = [
      'Release summary prepared for the upcoming engineering review meeting',
      '',
      '- Check **bold emphasis** and __strong markers__ in the notes above before publishing',
      '- Verify each item in the numbered sequence below during team handoff',
      '1. Run targeted unit tests before committing changes to the repository',
    ].join('\n');
    expect(analyzeContent(boldAndLists).primaryType).toBe('markdown');
  });
});
