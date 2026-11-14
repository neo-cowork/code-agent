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

describe('ResultSummary result words follow the UI language', () => {
  it.each([
    ['Glob files', resultCall('Glob', { pattern: '**/*.md' }, 'a.md\nb.md\nc.md'), '找到 3 个文件', 'Found 3 files'],
    ['Glob one file', resultCall('Glob', { pattern: '*.md' }, 'notes.md'), '找到 1 个文件：notes.md', 'Found 1 file: notes.md'],
    ['Grep results', resultCall('Grep', { pattern: 'todo' }, 'a.md:1:todo\nb.md:2:todo'), '找到 2 处结果', 'Found 2 results'],
    ['Grep one result', resultCall('Grep', { pattern: 'todo' }, 'a.md:7:todo'), '在 a.md:7 找到 1 处结果', 'Found 1 result in a.md:7'],
    ['other tool without output', resultCall('ListDirectory', { path: '.' }, ''), '完成', 'Done'],
    ['multi-line output', resultCall('task_status', {}, 'one\ntwo'), '完成', 'Done'],
    ['Edit same length', resultCall('Edit', { file_path: 'notes.md', edits: [{ old_text: 'a', new_text: 'b' }] }, 'Edited'), '已修改', 'Modified'],
    ['Edit unchanged', resultCall('Edit', { file_path: 'notes.md', edits: [{ old_text: 'a', new_text: 'a' }] }, 'Edited'), '无变化', 'No changes'],
    ['Bash git status clean', resultCall('Bash', { command: 'git status' }, 'nothing to commit, working tree clean'), '没有改动', 'No changes'],
    ['Bash many items', resultCall('Bash', { command: 'ls' }, 'a\nb\nc\nd\ne\nf'), '6 项', '6 items'],
    ['WebSearch', resultCall('WebSearch', { query: 'neo' }, '1. a\n2. b\nSources: brave'), '2 条结果 · 来自 brave', '2 results · via brave'],
    ['video', { ...resultCall('video_generate', {}, 'ok'), result: { toolCallId: 'v', success: true, output: 'ok', metadata: { duration: 5, aspectRatio: '16:9' } } } as ToolCall, '视频生成完成（5s, 16:9）', 'Video generated (5s, 16:9)'],
  ] as const)('renders %s in zh and en', (_label, toolCall, expectedZh, expectedEn) => {
    language = 'zh';
    render(<ResultSummary toolCall={toolCall} />);
    expect(document.body.textContent).toBe(expectedZh);
    expect(document.body.textContent).not.toMatch(/\b(?:Done|Found|items|results|Modified)\b/);
    cleanup();
    language = 'en';
    render(<ResultSummary toolCall={toolCall} />);
    expect(document.body.textContent).toBe(expectedEn);
    expect(document.body.textContent).not.toMatch(/[\u3400-\u9fff]/);
  });

  it('localizes the no-match sentinel when the status line does not own it', () => {
    const call = resultCall('Glob', { pattern: '*.xyz' }, 'No files matched the pattern');
    language = 'zh';
    render(<ResultSummary toolCall={call} />);
    const zhText = document.body.textContent ?? '';
    cleanup();
    language = 'en';
    render(<ResultSummary toolCall={call} />);
    const enText = document.body.textContent ?? '';
    expect([zhText, enText]).toSatisfy(([a, b]: string[]) => (a === '' && b === '') || (a === '无匹配' && b === 'No matches'));
    expect(zhText).not.toContain('No matches');
  });
});
