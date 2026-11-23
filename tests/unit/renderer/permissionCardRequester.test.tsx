// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';

const state = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  getTree: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { languages } = await import('../../../src/renderer/i18n');
  return { useI18n: () => ({ t: languages[state.language], language: state.language }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({ useAppStore: () => ({}) }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (select: (store: { currentSessionId: string }) => unknown) =>
    select({ currentSessionId: 'session-project' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invokeDomain: state.getTree },
}));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';

function request(id: string, agentId?: string): PermissionRequest {
  return {
    id,
    sessionId: 'session-project',
    agentId,
    tool: 'Bash',
    type: id === 'writer' ? 'dangerous_command' : 'command',
    details: { command: 'npm test' },
    timestamp: 1,
  };
}

afterEach(() => {
  cleanup();
  state.getTree.mockReset();
  state.language = 'zh';
});

describe('PermissionCard requesting helper', () => {
  it.each([
    ['zh', '来自：调研员', '来自：文档员', '允许执行这条命令？'],
    ['en', 'From: Researcher', 'From: Writer', 'Allow running this command?'],
  ] as const)('renders the matched roles above the question in %s', async (language, researcher, writer, question) => {
    state.language = language;
    state.getTree.mockResolvedValue({ nodes: [
      { id: 'agent-researcher', role: 'explore', displayName: 'Research helper internal name', background: true },
      { id: 'agent-writer', backgroundAgentId: 'subagent-bg-writer', role: 'documenter', background: true },
    ] });
    render(<>
      <PermissionCard requestOverride={request('researcher', 'agent-researcher')} />
      <PermissionCard requestOverride={request('writer', 'subagent-bg-writer')} />
    </>);
    const [first, second] = screen.getAllByTestId('permission-card');
    const header = await within(first).findByText(researcher);
    expect(await within(second).findByText(writer)).toBeDefined();
    expect(header.compareDocumentPosition(within(first).getByText(question)))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('uses the generic English label for a tree node without a named role', async () => {
    state.language = 'en';
    state.getTree.mockResolvedValue({ nodes: [{ id: 'agent-unnamed', role: 'background', background: true }] });
    await act(async () => {
      render(<PermissionCard requestOverride={request('unnamed', 'agent-unnamed')} />);
    });
    expect(screen.getByText('From: Assistant')).toBeDefined();
  });

  it('uses the assistant fallback for an unresolved identity and omits the line for foreground requests', async () => {
    state.getTree.mockResolvedValue({ nodes: [] });
    const { rerender } = render(<PermissionCard requestOverride={request('unknown', 'unresolved')} />);
    expect(await screen.findByText('来自：助手')).toBeDefined();
    rerender(<PermissionCard requestOverride={request('foreground')} />);
    expect(screen.queryByTestId('permission-card-header-line')).toBeNull();
  });
});
