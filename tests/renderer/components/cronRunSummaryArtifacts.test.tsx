// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CronRunMessageFrame } from '../../../src/renderer/components/features/chat/MessageBubble/CronRunMessageFrame';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

const source = '<cron_summary>Weekly report\nartifact: notes.md\nartifact: summary.md\n</cron_summary>';
function showRun(sourceRunId?: string): void {
  useSessionStore.setState({ currentSessionId: 'run', sessions: [{
    id: 'run', title: '[Schedule] Weekly report', workingDirectory: '/workspace',
    origin: { kind: 'cron', id: 'job' }, sourceRunId,
  } as SessionWithMeta] });
}
afterEach(() => {
  cleanup();
  useSessionStore.setState({ currentSessionId: null, sessions: [] });
  useCronStore.setState({ executionsByJobId: {} });
});
describe('cron summary artifacts use host settlement', () => {
  it('shows only the settled output even when the raw model summary lists input notes', () => {
    showRun('execution');
    useCronStore.setState({ executionsByJobId: { job: [{
      id: 'execution', jobId: 'job', status: 'completed', scheduledAt: 1, retryAttempt: 0,
      result: { digest: { artifacts: ['summary.md'] } },
    }] } });
    render(<CronRunMessageFrame sessionId="run" source={source} renderSlice={(text) => text} />);
    expect(screen.getByTestId('cron-run-summary').textContent).toContain('summary.md');
    expect(screen.getByTestId('cron-run-summary').textContent).not.toContain('notes.md');
  });
  it('does not briefly expose unvalidated model artifacts while settlement is loading', () => {
    showRun('execution');
    render(<CronRunMessageFrame sessionId="run" source={source} renderSlice={(text) => text} />);
    expect(screen.queryByTestId('cron-artifact-open')).toBeNull();
    expect(screen.getByTestId('cron-run-summary').textContent).toContain('Weekly report');
  });
  it('retains historical message artifacts without a linked execution', () => {
    showRun();
    render(<CronRunMessageFrame sessionId="run" source={source} renderSlice={(text) => text} />);
    expect(screen.getByTestId('cron-run-summary').textContent).toContain('notes.md');
    expect(screen.getByTestId('cron-run-summary').textContent).toContain('summary.md');
  });
});
