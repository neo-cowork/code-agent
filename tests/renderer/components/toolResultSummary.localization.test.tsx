// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ToolCall } from '../../../src/shared/contract';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { summarizeTool } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/summarizers';

let language: 'zh' | 'en' = 'zh';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: language === 'zh' ? zh : en, language }) };
});

import { ResultSummary } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ResultSummary';

afterEach(() => {
  cleanup();
  language = 'zh';
});

function writeCall(arguments_: Record<string, unknown>): ToolCall {
  return {
    id: 'write-1',
    name: 'Write',
    arguments: { file_path: 'notes.md', ...arguments_ },
    result: { toolCallId: 'write-1', success: true, output: 'Created file: notes.md' },
  } as ToolCall;
}

function resultCall(name: string, arguments_: Record<string, unknown>, output: string): ToolCall {
  return {
    id: `${name}-1`,
    name,
    arguments: arguments_,
    result: { toolCallId: `${name}-1`, success: true, output },
  } as ToolCall;
}

describe('ResultSummary Write line counts', () => {
  it.each([
    ['content_lines', { content_lines: 42 }, '42 行', '42 lines'],
    ['content', { content: 'one\ntwo\nthree' }, '3 行', '3 lines'],
  ] as const)('renders the %s branch in zh and en', (branch, arguments_, expectedZh, expectedEn) => {
    language = 'zh';
    render(<ResultSummary toolCall={writeCall(arguments_)} />);
    const zhText = document.body.textContent ?? '';
    console.log(`[zh] ${branch} ResultSummary DOM text:`, zhText);
    expect(zhText).toBe(expectedZh);
    expect(zhText).not.toContain('lines');

    cleanup();
    language = 'en';
    render(<ResultSummary toolCall={writeCall(arguments_)} />);
    const enText = document.body.textContent ?? '';
    console.log(`[en] ${branch} ResultSummary DOM text:`, enText);
    expect(enText).toBe(expectedEn);
  });
});

describe('summarizeTool line count translations', () => {
  it.each([
    ['Edit added', resultCall('Edit', { file_path: 'notes.md', edits: [{ old_text: 'a', new_text: 'a\nb' }] }, 'Edited'), '+1 行', '+1 lines'],
    ['Edit removed', resultCall('Edit', { file_path: 'notes.md', edits: [{ old_text: 'a\nb\nc', new_text: 'a' }] }, 'Edited'), '-2 行', '-2 lines'],
    ['Read', resultCall('Read', {}, 'one\ntwo'), '已读取 2 行', 'Read 2 lines'],
    ['Read with KB', resultCall('Read', {}, 'x'.repeat(10001)), '已读取 1 行（约 10KB）', 'Read 1 lines (~10KB)'],
    ['Bash', resultCall('Bash', { command: 'printf output' }, 'one\ntwo'), '2 行', '2 lines'],
    ['web_fetch', resultCall('web_fetch', {}, 'one\ntwo'), '2 行', '2 lines'],
  ] as const)('keeps the English string and localizes %s', (_label, toolCall, expectedZh, expectedEn) => {
    expect(summarizeTool(toolCall, zh)).toBe(expectedZh);
    expect(summarizeTool(toolCall, en)).toBe(expectedEn);
  });
});
