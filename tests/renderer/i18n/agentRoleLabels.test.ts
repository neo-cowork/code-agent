import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_AGENTS } from '../../../src/shared/contract/builtInAgents';
import { zh, en } from '../../../src/renderer/i18n';

describe('agent role label bundles', () => {
  it('covers every built-in role from both registries with short Chinese labels', () => {
    const core = readFileSync('src/host/agent/hybrid/coreAgents.ts', 'utf8');
    const ids = new Set([...Object.keys(BUILT_IN_AGENTS), ...Array.from(core.matchAll(/^ {4}id: '([^']+)'/gm), (match) => match[1])]);
    expect(Object.keys(zh.agentRoleLabels.roles).sort()).toEqual([...ids].sort());
    expect(Object.keys(en.agentRoleLabels.roles)).toEqual(Object.keys(zh.agentRoleLabels.roles));
    for (const label of [zh.agentRoleLabels.assistant, ...Object.values(zh.agentRoleLabels.roles)]) {
      expect(label).toMatch(/^[\p{Script=Han}]{2,4}$/u);
    }
    for (const label of Object.values(en.agentRoleLabels.roles)) expect(label).toMatch(/^[A-Za-z]+$/);
  });
});
