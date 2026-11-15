// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelDetail } from '../../../src/shared/contract/roleAssets';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...a: unknown[]) => invokeDomain(...a), on: () => () => {} },
}));
vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: () => Promise.resolve([]),
}));

import { RoleDetailPage } from '../../../src/renderer/components/features/expert/RoleDetailPage';

function detail(tools: string[], description?: string): RolePanelDetail {
  return {
    roleId: '研究员',
    definition: '---\nname: 研究员\n---\n你是调研专家',
    definitionPath: '/roles/研究员.md',
    ...(description ? { description } : {}),
    memories: [],
    history: [],
    proactivity: { level: 'silent' },
    visual: { displayName: '研究员', profession: '行业调研' },
    isBuiltin: false,
    personalization: { userExpectation: '', soul: '', boundaries: { disallowExternalSending: false } },
    equipment: { skills: [], tools, model: 'balanced', maxIterations: 20, availableSkills: [], availableTools: ['Read', 'WebSearch'] },
  };
}

function mockDetail(...queue: RolePanelDetail[]) {
  let i = 0;
  invokeDomain.mockImplementation((_d: string, action: string) => {
    if (action === 'detail') return Promise.resolve(queue[Math.min(i++, queue.length - 1)]);
    if (action === 'listBoundCronJobs' || action === 'listBindings') return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.setState({ language: 'zh' });
});

describe('RoleBasicSummary via RoleDetailPage', () => {
  it.each(['zh', 'en'] as const)('%s self-built expert summary is non-empty with plain-word abilities', async (language) => {
    useAppStore.setState({ language });
    mockDetail(detail(['Read', 'WebSearch'], '帮你做行业调研'));
    render(<RoleDetailPage roleId="研究员" />);
    const box = await screen.findByTestId('role-basic-summary');
    expect(box.textContent).toContain('研究员');
    expect(box.textContent).toContain('帮你做行业调研');
    expect(screen.getAllByTestId('role-basic-summary-ability').length).toBe(2);
    expect(box.textContent).not.toMatch(/WebSearch|web_search|\bRead\b/);
  });

  it('hides the Custom agent placeholder intro', async () => {
    mockDetail(detail(['Read'], 'Custom agent: 研究员'));
    render(<RoleDetailPage roleId="研究员" />);
    const box = await screen.findByTestId('role-basic-summary');
    expect(box.textContent).not.toContain('Custom agent');
    expect(screen.queryByTestId('role-basic-summary-intro')).toBeNull();
  });

  it('never shows the internal roleId when displayName is empty', async () => {
    const d = detail(['Read']);
    d.roleId = 'role-3f2a9c1e-7b44-4d0e-9a51-0c8d2e6b1f77';
    d.visual = {};
    mockDetail(d);
    render(<RoleDetailPage roleId={d.roleId} />);
    const name = await screen.findByTestId('role-basic-summary-name');
    expect(name.textContent).toBe('未命名专家');
    expect(screen.getByTestId('role-basic-summary').textContent).not.toContain(d.roleId);
  });

  it('shows a plain line when there are no abilities', async () => {
    mockDetail(detail([]));
    render(<RoleDetailPage roleId="研究员" />);
    expect(await screen.findByTestId('role-basic-summary-no-abilities')).toBeTruthy();
  });

  it('summary shows the newly added tool after the page reloads detail', async () => {
    mockDetail(detail(['Read']), detail(['Read', 'WebSearch']));
    const first = render(<RoleDetailPage roleId="研究员" />);
    await screen.findByTestId('role-basic-summary');
    expect(screen.getByTestId('role-basic-summary').textContent).not.toContain('搜索');
    first.unmount();
    render(<RoleDetailPage roleId="研究员" />);
    await waitFor(() => expect(screen.getByTestId('role-basic-summary').textContent).toContain('搜索'));
    expect(screen.getByTestId('role-basic-summary').textContent).not.toContain('WebSearch');
  });
});
