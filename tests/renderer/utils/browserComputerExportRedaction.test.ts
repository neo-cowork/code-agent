import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@shared/contract';
import { sanitizeMessagesForBrowserComputerExport } from '../../../src/renderer/utils/browserComputerExportRedaction';

const PAGE_TEXT = 'Welcome to the example page. Order total: 42 USD.';

function exportCall(name: string, extra: Partial<ToolCall> & { metadata?: Record<string, unknown> }): ToolCall {
  const { metadata, ...rest } = extra;
  const call: ToolCall = {
    id: 'call-1',
    name,
    arguments: { action: 'get_content', note: 'keep-me' },
    result: { toolCallId: 'call-1', success: true, output: PAGE_TEXT, metadata },
    ...rest,
  };
  const message = { id: 'm1', role: 'assistant', content: '', timestamp: 1, toolCalls: [call] } as Message;
  return sanitizeMessagesForBrowserComputerExport([message])[0].toolCalls![0];
}

describe('browser/computer export redaction keeps non-catalog tool names raw', () => {
  it('exports a Browser-named get_content call with its raw output and metadata', () => {
    const metadata = { domSnapshot: { headings: [] }, html: '<p>x</p>', elements: [{ id: 1 }] };
    const exported = exportCall('Browser', { metadata });
    expect(exported.result?.output).toBe(PAGE_TEXT);
    expect(exported.result?.metadata).toEqual(metadata);
  });

  it('does not collapse Browser-named arguments when surface metadata is present', () => {
    const metadata = { surfaceExecutionSessionV1: { sessionId: 's1', surface: 'browser' } };
    const exported = exportCall('Browser', { metadata });
    expect(exported.arguments).toEqual({ action: 'get_content', note: 'keep-me' });
  });

  it('still sanitizes browser_action calls', () => {
    const exported = exportCall('browser_action', {
      metadata: { domSnapshot: { headings: [] }, html: '<p>x</p>', elements: [{ id: 1 }] },
    });
    expect(exported.result?.output).not.toBe(PAGE_TEXT);
    expect(exported.result?.metadata).not.toHaveProperty('html');
  });
});
