import { describe, expect, it } from 'vitest';
import { diffRoleDefinition } from '../../../../src/host/services/roleAssets/roleEditChange';

const definition = { description: 'Research expert', tools: ['Read', 'Write'], systemPrompt: 'Read carefully.\nCite sources.' };

describe('diffRoleDefinition', () => {
  it('compares tools case-insensitively, deduplicates and retains display spelling', () => {
    expect(diffRoleDefinition(definition, { ...definition, tools: ['read', 'calendar', 'CALENDAR'] })).toEqual({
      addedTools: ['CALENDAR'], removedTools: ['Write'], descriptionChanged: false,
      promptLinesAdded: 0, promptLinesRemoved: 0,
    });
  });
  it('counts inserted and removed prompt lines around preserved lines', () => {
    expect(diffRoleDefinition(definition, { ...definition, description: 'Calendar expert', systemPrompt: 'Read carefully.\nCheck calendar.\nAsk before booking.' })).toMatchObject({
      descriptionChanged: true, promptLinesAdded: 2, promptLinesRemoved: 1,
    });
  });
  it('handles repeated lines and reordered lines using a sequence diff', () => {
    expect(diffRoleDefinition({ ...definition, systemPrompt: 'a\na\nb' }, { ...definition, systemPrompt: 'a\nb\na' })).toMatchObject({
      promptLinesAdded: 1, promptLinesRemoved: 1,
    });
  });
  it('normalizes file framing whitespace and CRLF without reporting changes', () => {
    expect(diffRoleDefinition(definition, { ...definition, tools: [' READ ', 'write'], systemPrompt: '\nRead carefully.\r\nCite sources.\n' })).toEqual({
      addedTools: [], removedTools: [], descriptionChanged: false, promptLinesAdded: 0, promptLinesRemoved: 0,
    });
  });
  it('handles empty prompts and tool lists without mutating inputs', () => {
    const empty = { description: '', tools: [], systemPrompt: '' };
    expect(diffRoleDefinition(empty, definition)).toMatchObject({ addedTools: ['Read', 'Write'], promptLinesAdded: 2, promptLinesRemoved: 0 });
    expect(diffRoleDefinition(definition, empty)).toMatchObject({ removedTools: ['Read', 'Write'], promptLinesAdded: 0, promptLinesRemoved: 2 });
    expect(definition.tools).toEqual(['Read', 'Write']);
  });
});
