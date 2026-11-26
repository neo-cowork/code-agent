// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { PARKED_APPROVAL_CLOSURE_SENTENCES } from '../../../src/shared/parkedApprovalClosure';

const languageState = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/stores/appStore', () => {
  const makeState = () => ({
    processingSessionIds: new Set<string>(),
    openPreview: vi.fn(),
    openSettingsTab: vi.fn(),
    workingDirectory: '/repo',
    language: languageState.value,
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  });
  return {
    useAppStore: (selector?: (value: ReturnType<typeof makeState>) => unknown) => {
      const state = makeState();
      return selector ? selector(state) : state;
    },
  };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) => (
    selector({ currentSessionId: 'session-1' })
  ),
}));

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';

afterEach(cleanup);

const VOID = PARKED_APPROVAL_CLOSURE_SENTENCES.argsUnavailable;
const BAD = /未成功|Could not|failed|Failed/;

function call(id: string, name: string, args: Record<string, unknown>, error: string): ToolCall {
  return { id, name, arguments: args, result: { toolCallId: id, success: false, error, duration: 0 } };
}

const KINDS: [string, string, Record<string, unknown>][] = [
  ['Bash', 'Bash', { command: 'rm -rf drafts' }],
  ['Write', 'Write', { file_path: '/repo/notes/a.md', content: 'x' }],
  ['Read', 'Read', { file_path: '/repo/notes/a.md' }],
  ['MCP', 'mcp__demo__create_item', { title: 'x' }],
];

describe('作废（从未执行）的步骤：标题与下方原因行同一状态', () => {
  describe.each(KINDS)('%s', (_label, name, args) => {
    it('zh：标题 未执行 · …，无 未成功', () => {
      languageState.value = 'zh';
      const view = render(<ToolCallDisplay toolCall={call('v1', name, args, VOID)} index={0} total={1} />);
      const text = view.container.textContent ?? '';
      expect(text).toMatch(/^●?未执行 · /);
      expect(text).not.toMatch(BAD);
    });
    it('en：标题 Not run · …，无 Could not', () => {
      languageState.value = 'en';
      const view = render(<ToolCallDisplay toolCall={call('v2', name, args, VOID)} index={0} total={1} />);
      const text = view.container.textContent ?? '';
      expect(text).toMatch(/^●?Not run · /);
      expect(text).not.toMatch(BAD);
    });
  });

  it('反例：真失败的 Bash（非收口句）标题仍是 未成功', () => {
    languageState.value = 'zh';
    const view = render(<ToolCallDisplay toolCall={call('f1', 'Bash', { command: 'ls' }, 'exit code 1')} index={0} total={1} />);
    expect(view.container.textContent).toContain('未成功');
    expect(view.container.textContent).not.toMatch(/^●?未执行/);
  });

  it('反例：真失败的 Bash en 仍是 Could not', () => {
    languageState.value = 'en';
    const view = render(<ToolCallDisplay toolCall={call('f2', 'Bash', { command: 'ls' }, 'exit code 1')} index={0} total={1} />);
    expect(view.container.textContent).toContain('Could not');
  });

  function node(id: string, name: string, args: Record<string, unknown>, error: string): TraceNode {
    return { id: `n-${id}`, type: 'tool_call', content: '', timestamp: 1,
      toolCall: { id, name, args, success: false, result: error } } as TraceNode;
  }

  it('组：全部作废 → 组头 未执行，无 未成功', () => {
    languageState.value = 'zh';
    const view = render(<ToolStepGroup nodes={[node('g1', 'Bash', { command: 'a' }, VOID), node('g2', 'Bash', { command: 'b' }, VOID)]} />);
    const text = view.container.textContent ?? '';
    expect(text).toContain('未执行 · ');
    expect(text).not.toContain('未成功');
  });

  it.each(['zh', 'en'] as const)('组：全部作废 → 整组文本无 失败/failed 计数（%s）', (lang) => {
    languageState.value = lang;
    const view = render(<ToolStepGroup nodes={[node('h1', 'Bash', { command: 'a' }, VOID), node('h2', 'Bash', { command: 'b' }, VOID)]} />);
    const text = view.container.textContent ?? '';
    expect(text).not.toMatch(/失败|failed|Failed|未成功|Could not/);
  });

  it('组：混合 → 失败计数只算真失败（1 个）', () => {
    languageState.value = 'zh';
    const view = render(<ToolStepGroup nodes={[node('i1', 'Bash', { command: 'a' }, VOID), node('i2', 'Bash', { command: 'b' }, 'exit code 1')]} />);
    expect(view.container.textContent).not.toContain('2 失败');
  });

  it('组：混合（1 作废 + 1 真失败）→ 同时出现 未执行 与 未成功', () => {
    languageState.value = 'zh';
    const view = render(<ToolStepGroup nodes={[node('m1', 'Bash', { command: 'a' }, VOID), node('m2', 'Bash', { command: 'b' }, 'exit code 1')]} />);
    const text = view.container.textContent ?? '';
    expect(text).toContain('未执行 · ');
    expect(text).toContain('未成功');
  });
});
