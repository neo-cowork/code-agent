import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDelegatedTaskPrompt } from '../../../../src/host/services/commandCenter/delegationGuidance';
import { DELEGATED_SCAFFOLDING_MARKERS } from '../../../utils/delegatedScaffoldingMarkers';

const SRC = path.resolve(__dirname, '../../../../src');
const DEFINITION = path.join(SRC, 'host/services/commandCenter/delegationGuidance.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

// Structural gate: every production entry that builds the delegated prompt must also hand the
// plan to the run as displayContent, otherwise the scaffolding is persisted as a user row.
describe('buildDelegatedTaskPrompt callers keep scaffolding model-facing only', () => {
  it('the shared marker list matches what the builder really emits', () => {
    const prompt = buildDelegatedTaskPrompt('PLAN', 'ORIGINAL');
    for (const marker of DELEGATED_SCAFFOLDING_MARKERS) expect(prompt).toContain(marker);
  });

  it('every caller passes the plan it built the prompt from as displayContent', () => {
    const callers = sourceFiles(SRC).filter((file) => file !== DEFINITION)
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter(({ text }) => text.includes('buildDelegatedTaskPrompt('));
    expect(callers.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const { file, text } of callers) {
      for (const match of text.matchAll(/buildDelegatedTaskPrompt\(\s*([A-Za-z_$][\w$]*)/g)) {
        const plan = match[1];
        if (!new RegExp(`displayContent:\\s*${plan.replace(/\$/g, '\\$')}\\b`).test(text)) {
          offenders.push(`${path.relative(SRC, file)}: plan "${plan}" has no matching displayContent`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
