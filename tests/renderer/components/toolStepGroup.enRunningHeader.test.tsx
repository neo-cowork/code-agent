// @vitest-environment jsdom
// N-FIX-EN-TURN-HEADER-LOWERCASE-STATUS-AND-MONO-TOOL-COPY：英文组头的进行中状态词来自 i18n、
// 不再是裸小写 `running`；行外壳用正文字体，真实命令/路径块仍是等宽。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { languages } from '../../../src/renderer/i18n';

const SESSION = 'sess-en-running';

function liveBash(id: string, command: string): TraceNode {
  return {
    id, type: 'tool_call', content: '', timestamp: 1_000,
    toolCall: { id: `${id}-call`, name: 'Bash', args: { command } },
  } as TraceNode;
}

describe('English running group header', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ processingSessionIds: new Set<string>(), isProcessing: false });
    useSessionStore.setState({ currentSessionId: null });
  });

  function renderLive(): void {
    useAppStore.setState({ language: 'en', processingSessionIds: new Set([SESSION]), isProcessing: true });
    useSessionStore.setState({ currentSessionId: SESSION });
    render(<ToolStepGroup nodes={[liveBash('a', 'ls ~/plans'), liveBash('b', 'cat plan.md')]} sessionId={SESSION} defaultExpanded />);
  }

  it('① status word comes from i18n and is not the bare lowercase enum', () => {
    renderLive();
    const status = screen.getByTestId('tool-group-head-status').textContent ?? '';
    expect(status).toBe(`${languages.en.toolGroup.statusRunning} · `);
    expect(status).toBe('In progress · ');
    expect(status).not.toMatch(/^running/);
  });

  it('② row wrapper has no font-mono; command output block stays monospace', () => {
    renderLive();
    const rows = screen.getAllByTestId('tool-call-row-Bash');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const wrapper = row.parentElement as HTMLElement;
      expect(wrapper.classList.contains('group')).toBe(true);
      expect(wrapper.classList.contains('font-mono')).toBe(false);
    }
    // 状态词/动词文案节点不带等宽
    const head = screen.getByTestId('tool-group-head-label');
    expect(head.className).not.toContain('font-mono');
  });

  it('③ no en toolGroup status value is an all-lowercase single word', () => {
    for (const [key, value] of Object.entries(languages.en.toolGroup)) {
      if (!/^status/.test(key) || typeof value !== 'string') continue;
      expect(value, `toolGroup.${key}`).not.toMatch(/^[a-z]+$/);
    }
  });
});
