// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import persistedResults from './persisted-status.json';

const language = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/stores/appStore', () => {
  const useAppStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      processingSessionIds: new Set<string>(), workingDirectory: '/workspace',
      language: language.value, setLanguage: vi.fn(), cloudUIStrings: undefined,
    };
    return selector ? selector(state) : state;
  };
  return { useAppStore: Object.assign(useAppStore, { getState: () => useAppStore() }) };
});
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'status-card-session' }),
}));

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';

const labels = {
  zh: { running: '进行中', completed: '已完成', failed: '失败', cancelled: '已中断' },
  en: { running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Interrupted' },
};

afterEach(cleanup);

describe('persisted background-task status card', () => {
  for (const locale of ['zh', 'en'] as const) {
    for (const [status, result] of Object.entries(persistedResults)) {
      it(`${locale}: ${status} stays human-readable collapsed, expanded and remounted`, () => {
        language.value = locale;
        // Copied from neo-realrun db snapshots: model-facing output and metadata stay together.
        const toolCall: ToolCall = {
          id: result.toolCallId, name: 'task_status', arguments: {}, result,
          // Real persisted shape: the model used the raw tool name as its short description.
          shortDescription: 'Use task_status',
        };
        const expected = labels[locale][status as keyof typeof labels.zh];
        const assertVisible = (text: string) => {
          expect(text).toContain(result.metadata.sessionTask.tasks[0].shortName);
          expect(text).toContain(expected);
          expect(text).not.toMatch(/\[(?:running|completed|failed|cancelled)\]|id=|session-work-|\bDone\b/);
          expect(text).not.toMatch(/task_status|delegate_task|cancel_task/);
          if (locale === 'zh') expect(text).not.toMatch(/\b(?:Running|Completed|Failed|Interrupted)\b/);
        };
        const mount = () => render(<ToolCallDisplay toolCall={JSON.parse(JSON.stringify(toolCall))} index={0} total={1} />);
        const view = mount();
        const row = view.getByTestId('tool-call-row-task_status');
        expect(row.getAttribute('aria-expanded')).toBe('false');
        assertVisible(row.textContent ?? '');
        fireEvent.click(row);
        assertVisible(view.container.textContent ?? '');
        fireEvent.click(row);
        assertVisible(row.textContent ?? '');
        view.unmount();
        const reopened = mount();
        assertVisible(reopened.getByTestId('tool-call-row-task_status').textContent ?? '');
        fireEvent.click(reopened.getByTestId('tool-call-row-task_status'));
        assertVisible(reopened.container.textContent ?? '');
        expect(result.output).toMatch(/\[\w+\] id=session-work-/);
      });
    }
  }
});
