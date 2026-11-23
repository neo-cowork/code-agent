import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { en } from '../../../src/renderer/i18n/en';
import { summarizeTool } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/summarizers';

function call(output: string, metadata?: Record<string, unknown>): ToolCall {
  return {
    id: 'tc-ls',
    name: 'ListDirectory',
    arguments: { path: '/tmp/x' },
    result: { toolCallId: 'tc-ls', success: true, output, metadata },
  } as ToolCall;
}

describe('summarizeTool ListDirectory', () => {
  it('does not count the nextOffset footer or empty placeholders', () => {
    expect(summarizeTool(call('(empty page)\n\nnextOffset: null'), en)).toBe('0 items');
    expect(summarizeTool(call('(empty — this folder has no files yet)\n\nnextOffset: null'), en)).toBe('0 items');
    expect(summarizeTool(call('a.txt\n\nnextOffset: null'), en)).toBe('1 items');
  });

  it('prefers metadata.entryCount when present', () => {
    expect(summarizeTool(call('a.txt\nb.txt\n\nnextOffset: 2', { entryCount: 5 }), en)).toBe('5 items');
  });
});
