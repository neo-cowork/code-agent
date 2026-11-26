import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalOutput } from '../../../src/cli/output/terminal';
import type { AgentEvent, ToolCall, ToolResult } from '../../../src/shared/contract';

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

describe('TerminalOutput', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureOutput(): { logs: string[]; errors: string[]; writes: string[] } {
    const logs: string[] = [];
    const errors: string[] = [];
    const writes: string[] = [];

    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(stripAnsi(args.map(String).join(' ')));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(stripAnsi(args.map(String).join(' ')));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(stripAnsi(String(chunk)));
      return true;
    }) as never);

    return { logs, errors, writes };
  }

  it('renders welcome, prompt, info, success, and warning text', () => {
    const output = new TerminalOutput();
    const { logs, writes } = captureOutput();

    output.welcome('1.2.3', {
      model: 'gpt-test',
      provider: 'openai',
      workingDirectory: '/tmp/project',
    });
    output.prompt();
    output.info('ready');
    output.success('done');
    output.warn('careful');

    const text = [...logs, ...writes].join('\n');
    expect(text).toContain('Agent Neo v1.2.3');
    expect(text).toContain('openai/gpt-test');
    expect(text).toContain('/tmp/project');
    expect(text).toContain('ready');
    expect(text).toContain('done');
    expect(text).toContain('careful');
  });

  it('renders tool calls and tool results with compact argument summaries', () => {
    const output = new TerminalOutput();
    const { logs } = captureOutput();

    output.toolCall({
      id: 'call-1',
      name: 'Read',
      arguments: { path: '/tmp/project/README.md' },
    } as ToolCall);
    output.toolCall({
      id: 'call-2',
      name: 'mcp__github__search',
      arguments: { query: 'issues' },
    } as ToolCall);
    output.toolResult({ toolCallId: 'call-1', success: true, output: 'first line\nsecond line' } as ToolResult);
    output.toolResult({ toolCallId: 'call-2', success: false, error: 'bad token' } as ToolResult);

    const text = logs.join('\n');
    expect(text).toContain('Read');
    expect(text).toContain('/tmp/project/README.md');
    expect(text).toContain('mcp:github search');
    expect(text).toContain('"issues"');
    expect(text).toContain('first line second line');
    expect(text).toContain('bad token');
  });

  it('streams chunks, suppresses duplicate assistant messages, and routes errors to stderr', () => {
    const output = new TerminalOutput();
    const { errors, writes } = captureOutput();

    output.handleEvent({ type: 'stream_chunk', data: { content: 'hel' } } as AgentEvent);
    output.handleEvent({ type: 'stream_chunk', data: { content: 'lo' } } as AgentEvent);
    output.handleEvent({ type: 'message', data: { role: 'assistant', content: 'hello' } } as AgentEvent);
    output.error('visible');

    expect(writes.join('')).toContain('hello');
    expect(errors.join('\n')).toContain('visible');
  });

  it('tracks model response metadata into the task completion status line', () => {
    const output = new TerminalOutput();
    const { logs } = captureOutput();

    output.handleEvent({
      type: 'model_response',
      data: {
        model: 'gpt-test',
        provider: 'openai',
        responseType: 'message',
        duration: 20,
        toolCalls: [],
        textLength: 5,
        inputTokens: 1200,
        outputTokens: 300,
      },
    } as AgentEvent);
    output.updateContextUsage(50, 4000, 8000);
    output.taskComplete(1500, ['Read', 'Read', 'Write']);

    const text = logs.join('\n');
    expect(text).toContain('openai/gpt-test');
    expect(text).toContain('1.5k tokens');
    expect(text).toContain('1 turns');
    expect(text).toContain('2 tools');
    expect(text).toContain('ctx');
  });

  it('renders the backend turn diff summary directly', () => {
    const output = new TerminalOutput();
    const { writes } = captureOutput();

    output.handleEvent({
      type: 'turn_diff',
      data: {
        turnId: 'turn-1',
        files: [{
          filePath: '/repo/a.ts',
          oldText: 'old',
          newText: 'new\nline',
          added: 2,
          removed: 1,
          isNewFile: false,
          editCount: 1,
        }],
      },
    } as AgentEvent);

    expect(writes.join('')).toContain('1 files changed');
    expect(writes.join('')).toContain('+2');
    expect(writes.join('')).toContain('-1');
  });

  it('prints missing files instead of an empty authoritative diff', () => {
    const output = new TerminalOutput();
    const { writes } = captureOutput();

    output.handleEvent({
      type: 'turn_diff',
      data: {
        turnId: 'turn-1',
        files: [],
        missingFiles: ['/repo/b.docx'],
        filesAuthoritative: false,
      },
    } as AgentEvent);

    const text = writes.join('');
    expect(text).toContain('not written: /repo/b.docx');
    expect(text).not.toContain('files changed');
  });

  // N-FIX-FALLBACK-BANNER-TO-FIELD-ZH-LITERAL：链耗尽的 model_fallback 事件没有 `to`
  // （exhausted: true）——打印 "not switched" 而不是 "undefined"，且不污染跟踪的当前模型。
  it('prints not switched for an exhausted model_fallback and keeps the tracked model unset', () => {
    const output = new TerminalOutput();
    const { logs } = captureOutput();

    output.handleEvent({
      type: 'model_fallback',
      data: { reason: 'Moonshot API error: 503 service unavailable', from: 'zhipu/glm-4.7-flash', exhausted: true },
    } as AgentEvent);

    const text = logs.join('\n');
    expect(text).toContain('zhipu/glm-4.7-flash → not switched');
    expect(text).not.toContain('undefined');

    // 耗尽事件不设置 currentModel：任务完成摘要里不得出现模型标签
    const logsBeforeSummary = logs.length;
    output.taskComplete(1500, []);
    expect(logs.slice(logsBeforeSummary).join('\n')).not.toContain('not switched');
  });

  it('still prints and tracks the target model for a non-exhausted model_fallback', () => {
    const output = new TerminalOutput();
    const { logs } = captureOutput();

    output.handleEvent({
      type: 'model_fallback',
      data: { reason: 'Moonshot API error: 503 service unavailable', from: 'zhipu/glm-4.7-flash', to: 'moonshot/kimi-k2.5' },
    } as AgentEvent);

    expect(logs.join('\n')).toContain('zhipu/glm-4.7-flash → moonshot/kimi-k2.5');

    output.taskComplete(1500, []);
    expect(logs.join('\n')).toContain('moonshot/kimi-k2.5');
  });
});
