// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectTrustConfirmCard } from '../../../src/renderer/components/features/chat/ProjectTrustConfirmCard';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { languages } from '../../../src/renderer/i18n';
import type { Message } from '../../../src/shared/contract';
import type { ProjectDetail } from '../../../src/shared/contract/project';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), domain: vi.fn(), detail: vi.fn(), update: vi.fn() }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: {
  unsafeInvoke: mocks.confirm, invokeDomain: mocks.domain,
} }));
vi.mock('../../../src/renderer/services/projectClient', () => ({
  getProjectDetail: mocks.detail, getProjectSourceGitStates: async () => [],
  updateProject: mocks.update, deleteProject: vi.fn(),
}));
vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => true, isTauriMode: () => false }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({
  t: languages[useAppStore((s) => s.language)],
}) }));

const messages: Message[] = [
  { id: 'original-client-id', role: 'user', content: 'Summarize notes.txt into 3 bullet points', timestamp: 1 },
  { id: 'trust-error', role: 'assistant', content: 'Folder confirmation needed', timestamp: 2,
    metadata: { retryPrompt: 'Summarize notes.txt into 3 bullet points', retryClientMessageId: 'original-client-id',
      retrySessionId: 'session-a', sendFailureCode: 'PROJECT_SOURCE_TRUST' } },
];
const node = projectTurns(messages, 'session-a', false).turns.flatMap((turn) => turn.nodes)
  .find((item) => item.messageId === 'trust-error' || item.id.startsWith('trust-error'))!;
const detail: ProjectDetail = {
  project: { id: 'project-a', name: 'Weekly notes', workspacePath: '/repo/notes', workspaceKey: 'notes',
    status: 'active', createdAt: 1, updatedAt: 1, sourceRevision: 1 },
  sources: [{ id: 'source-a', projectId: 'project-a', path: '/repo/notes', canonicalPath: '/repo/notes',
    role: 'primary', access: 'read_write', trustState: 'trusted', createdAt: 1, updatedAt: 1 }],
  goals: [], roles: [], sessionIds: ['session-a'],
};

beforeEach(() => {
  vi.resetAllMocks();
  useAppStore.setState({ language: 'en' });
  useSessionStore.setState({ currentSessionId: 'session-b', messages, sessions: [{
    id: 'session-a', projectId: 'project-a', title: 'Weekly notes', status: 'idle',
    createdAt: 1, updatedAt: 1, messageCount: 0, turnCount: 0, modelConfig: useAppStore.getState().modelConfig,
  }] });
  mocks.detail.mockResolvedValue(detail);
  mocks.update.mockResolvedValue(detail);
  mocks.domain.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  useMessageActionStore.getState().unregister();
  useSessionStore.setState({ currentSessionId: null, sessions: [], messages: [] });
});

describe('ProjectTrustConfirmCard rejection recovery', () => {
  it.each(['zh', 'en'] as const)('renders a distinct plain sentence for every reason in %s', async (language) => {
    useAppStore.setState({ language });
    const copy = languages[language].turnCard.projectTrustConfirm;
    const rendered: string[] = [];
    for (const reason of Object.keys(copy.reasons) as Array<keyof typeof copy.reasons>) {
      mocks.confirm.mockResolvedValueOnce({ confirmed: false, reason, folderName: 'Weekly notes' });
      render(<ProjectTrustConfirmCard node={node} sessionId="session-b" />);
      fireEvent.click(screen.getByRole('button', { name: copy.button }));
      const expected = copy.reasons[reason].replace('{name}', 'Weekly notes');
      await screen.findByText(expected);
      const card = screen.getByTestId('project-trust-confirm');
      expect(card.textContent).not.toContain(copy.failed);
      expect(card.textContent).not.toContain(reason);
      expect(card.textContent).not.toContain('/repo/');
      expect(Boolean(screen.queryByRole('button', { name: copy.reselect })))
        .toBe(reason === 'source_missing' || reason === 'identity_changed');
      expect(mocks.confirm).toHaveBeenLastCalledWith('project:confirm-source-trust', { sessionId: 'session-a' });
      rendered.push(expected);
      cleanup();
    }
    expect(new Set(rendered).size).toBe(Object.keys(copy.reasons).length);
  });

  it.each(['source_missing', 'identity_changed'])('opens the real settings dialog and re-confirms/resends once after %s', async (reason) => {
    useSessionStore.setState({ currentSessionId: 'session-a' });
    const send = vi.fn();
    useMessageActionStore.getState().register(send, () => messages);
    mocks.confirm.mockResolvedValueOnce({ confirmed: false, reason, folderName: 'notes' })
      .mockResolvedValueOnce({ confirmed: true, sources: 0 });
    render(<ProjectTrustConfirmCard node={node} sessionId="session-b" />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and resend' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Re-select folder' }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(mocks.detail).toHaveBeenCalledWith('project-a'));
    const settings = languages.en.sidebarProject.settings;
    fireEvent.change(screen.getByRole('textbox', { name: settings.sourcePathAria }), { target: { value: '/repo/reselected' } });
    fireEvent.click(screen.getByRole('button', { name: settings.addFolder }));
    await screen.findByText('/repo/reselected');
    fireEvent.click(screen.getByRole('button', { name: settings.setPrimary }));
    fireEvent.click(screen.getByRole('button', { name: settings.remove }));
    fireEvent.click(screen.getByRole('button', { name: settings.save }));
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith(messages[0]!.content, { clientMessageId: 'original-client-id' }));
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-a',
      sources: [expect.objectContaining({ path: '/repo/reselected', role: 'primary' })] }));
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('project-trust-confirm')).toBeNull();
    expect(useSessionStore.getState().messages.map((message) => message.id)).toEqual(['original-client-id']);
  });

  it('does not resend into a different current session after confirmation', async () => {
    const send = vi.fn();
    useMessageActionStore.getState().register(send, () => messages);
    mocks.confirm.mockResolvedValue({ confirmed: true });
    render(<ProjectTrustConfirmCard node={node} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and resend' }));
    await screen.findByText(languages.en.turnCard.projectTrustConfirm.failed);
    expect(send).not.toHaveBeenCalled();
    expect(useSessionStore.getState().messages).toEqual(messages);
  });

  it('does not retry after closing settings or deleting the project', async () => {
    mocks.confirm.mockResolvedValue({ confirmed: false, reason: 'source_missing' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ProjectTrustConfirmCard node={node} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and resend' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Re-select folder' }));
    await screen.findByText('/repo/notes');
    fireEvent.click(screen.getByRole('button', { name: languages.en.sidebarProject.settings.cancel }));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Re-select folder' }));
    await screen.findByText('/repo/notes');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: languages.en.sidebarProject.settings.deleteProject })));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('project-trust-confirm')).toBeTruthy();
    vi.restoreAllMocks();
  });

  it.each([undefined, { confirmed: false, reason: 'unknown' }])('keeps unknown failures generic: %j', async (response) => {
    mocks.confirm.mockResolvedValue(response);
    render(<ProjectTrustConfirmCard node={node} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and resend' }));
    await screen.findByText(languages.en.turnCard.projectTrustConfirm.failed);
    expect(screen.queryByRole('button', { name: 'Re-select folder' })).toBeNull();
  });

  it('keeps a network rejection generic and never resends', async () => {
    mocks.confirm.mockRejectedValue(new TypeError('Failed to fetch'));
    const send = vi.fn();
    useMessageActionStore.getState().register(send, () => messages);
    render(<ProjectTrustConfirmCard node={node} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and resend' }));
    await screen.findByText(languages.en.turnCard.projectTrustConfirm.failed);
    expect(send).not.toHaveBeenCalled();
  });
});
