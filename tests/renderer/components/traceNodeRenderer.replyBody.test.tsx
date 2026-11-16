// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { WakeRationaleNote } from '../../../src/renderer/components/features/chat/WakeRationaleNote';

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/MessageContent', () => ({
  MessageContent: ({ content }: { content: string }) => <div data-testid="reply-markdown-input">{content}</div>,
}));
vi.mock('../../../src/renderer/hooks/useSmoothStreamingText', () => ({
  useSmoothStreamingText: ({ content }: { content: string }) => ({ displayContent: content, isAnimating: false, tailStartIndex: content.length }),
}));

afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });
const assistant = (content: string, metadata?: TraceNode['metadata']): TraceNode => ({
  id: 'reply-test', type: 'assistant_text', timestamp: 1, content, metadata,
});

describe.each(['zh', 'en'] as const)('reply protocol scope (%s)', (language) => {
  it.each([
    '<decision>Choose this</decision><rationale>Keep this template</rationale><evidence>Keep these facts</evidence>',
    'Use `<evidence>` tags, then keep this whole explanation.',
    'Use <rationale> followed by all of this finalized answer.',
    '```xml\n<rationale>Reason</rationale>\n<evidence>Facts</evidence>\n```\nAfter the code.',
    '```wake_proposals\n{"title":"An example"}\n```',
  ])('passes ordinary reply bytes to Markdown without a technical disclosure: %s', (raw) => {
    useAppStore.setState({ language, cloudUIStrings: null });
    const view = render(<TraceNodeRenderer node={assistant(raw)} />);
    expect(screen.getByTestId('reply-markdown-input').textContent).toBe(raw);
    expect(screen.queryByTestId('reply-technical-details')).toBeNull();
    expect(screen.queryByTestId('wake-rationale')).toBeNull();
    view.rerender(<TraceNodeRenderer node={assistant(raw)} isStreaming />);
    expect(screen.getByTestId('reply-markdown-input').textContent).toBe(raw);
    expect(screen.queryByTestId('reply-technical-details')).toBeNull();
  });

  it('uses explicit wake metadata and only truncates unfinished controls during streaming', () => {
    useAppStore.setState({ language, cloudUIStrings: null });
    const raw = 'Use `<evidence>` here.\n\n<decision>report</decision><rationale>Keep this unfinished final sentence.';
    const node = assistant(raw, { wakeRationale: { missing: true } });
    const view = render(<TraceNodeRenderer node={node} isStreaming />);
    expect(screen.getByTestId('reply-markdown-input').textContent).toBe('Use `<evidence>` here.');
    view.rerender(<TraceNodeRenderer node={node} isStreaming={false} />);
    expect(screen.getByTestId('reply-markdown-input').textContent).toBe('Use `<evidence>` here.\n\n<rationale>Keep this unfinished final sentence.');
    expect(node.content).toBe(raw);
  });

  it('uses cron metadata without interpreting user template tags as wake controls', () => {
    useAppStore.setState({ language, cloudUIStrings: null });
    const raw = '<rationale>User template</rationale>\n<cron_event_decision id="event" action="ignore">No action.</cron_event_decision>';
    render(<TraceNodeRenderer node={assistant(raw, { automation: {
      automationId: 'cron:test', automationType: 'cron', event: 'completed', sourceSessionId: 'source',
    } })} />);
    expect(screen.getByTestId('reply-markdown-input').textContent).toBe('<rationale>User template</rationale>');
  });

  it('projects controls on explicit role-wake automation messages', () => {
    useAppStore.setState({ language, cloudUIStrings: null });
    render(<TraceNodeRenderer node={assistant('Report ready.<decision>report</decision><rationale>Review notes.</rationale>', {
      automation: { automationId: 'wake:test', automationType: 'role_wake', event: 'completed', sourceSessionId: 'source' },
    })} />);
    expect(screen.getByTestId('reply-markdown-input').textContent).toBe('Report ready.');
    expect(screen.getByTestId('wake-rationale')).toBeTruthy();
  });

  it('does not reinterpret already parsed rationale/evidence fields as protocol', () => {
    useAppStore.setState({ language, cloudUIStrings: null });
    const raw = 'Use <rationale> and preserve the following recorded explanation.';
    render(<WakeRationaleNote fields={{ rationale: raw, evidence: 'Use `<evidence>` in the example.', missing: false }} />);
    fireEvent.click(screen.getByTestId('wake-rationale-why'));
    expect(screen.getByTestId('wake-rationale-text').textContent).toBe(raw);
    expect(screen.getByTestId('wake-rationale-evidence').textContent).toContain('Use `<evidence>` in the example.');
  });
});
