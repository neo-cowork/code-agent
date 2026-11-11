import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.doUnmock('../../../src/host/config/renderDataDir');
  vi.resetModules();
  if (root) await rm(root, { recursive: true, force: true });
});

async function setup(slot: boolean) {
  root = await mkdtemp(path.join(tmpdir(), 'model-text-'));
  vi.stubEnv('CODE_AGENT_HOME', root);
  vi.stubEnv('CODE_AGENT_DATA_DIR', slot ? path.join(root, '.code-agent-dev3') : undefined);
  vi.resetModules();
  return path.join(root, '.code-agent-dev3');
}

async function render() {
  const { BUILTIN_SKILLS } = await import('../../../src/host/services/skills/builtinSkillsData');
  const { renderSkillContent } = await import('../../../src/host/services/skills/skillRenderer');
  const { buildPrompt } = await import('../../../src/host/prompts/builder');
  const xlsx = BUILTIN_SKILLS.find(skill => skill.name === 'xlsx');
  expect(xlsx).toBeDefined();
  return { skill: renderSkillContent(xlsx!.promptContent), prompt: buildPrompt(), rawSkill: xlsx!.promptContent };
}

describe('model-facing slot data directory', () => {
  it.each([false, true])('buildPrompt memory text and real xlsx skill use .code-agent-dev3 (custom SOUL=%s)', async customSoul => {
    const slot = await setup(true);
    if (customSoul) {
      await mkdir(slot, { recursive: true });
      await writeFile(path.join(slot, 'SOUL.md'), 'Custom identity for this test.');
    }
    const { skill, prompt } = await render();
    expect(skill).not.toContain('~/.code-agent/');
    expect(skill).toContain(`${slot}/skills/anthropic-skills/skills/skills/xlsx/recalc.py`);
    expect(prompt).not.toContain('~/.code-agent/');
    expect(prompt).toContain(`persistent, file-based memory system at: ${slot}/memory/`);
  });

  it('env unset preserves byte-identical buildPrompt and builtin xlsx against unchanged rendering', async () => {
    await setup(false);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
    vi.doMock('../../../src/host/config/renderDataDir', () => ({ renderDataDir: (text: string) => text }));
    const baseline = await render();
    vi.doUnmock('../../../src/host/config/renderDataDir');
    vi.resetModules();
    const actual = await render();
    expect(actual).toEqual(baseline);
    expect(actual.skill).toBe(actual.rawSkill);
    expect(actual.prompt).toContain('persistent, file-based memory system at: ~/.code-agent/memory/');
  });

  it('live registry evaluation follows slot switches, bare paths, and preserves sibling names', async () => {
    const slot = await setup(true);
    const registry = await import('../../../src/host/prompts/registry');
    const live = registry.applyOverride({ id: 'slot-text', category: 'Test', name: 'Slot' }, '`~/.code-agent` ~/.code-agent/child ~/.code-agent-dev4/');
    expect(String(live)).toBe(`\`${slot}\` ${slot}/child ~/.code-agent-dev4/`);
    expect(registry.lookupPromptText('slot-text')).toBe(String(live));
    vi.stubEnv('CODE_AGENT_DATA_DIR', undefined);
    expect(String(live)).toBe('`~/.code-agent` ~/.code-agent/child ~/.code-agent-dev4/');
  });
});
