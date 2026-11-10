// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelDetail } from '../../../src/shared/contract/roleAssets';

const invokeDomain = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: () => () => {} },
}));
import { RoleDetailPage } from '../../../src/renderer/components/features/expert/RoleDetailPage';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const detail: RolePanelDetail = {
  roleId: '日程管家', definition: null, definitionPath: '',
  memories: [], history: [], proactivity: { level: 'silent' },
  visual: {}, isBuiltin: false,
  personalization: { userExpectation: '', soul: '', boundaries: { disallowExternalSending: false } },
  equipment: {
    skills: [], tools: ['Read', 'fooBar', 'fooBar'], model: 'balanced', maxIterations: 20,
    availableSkills: [], availableTools: ['Read'],
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.setState({ language: 'zh' });
});

describe('expert detail unknown tools', () => {
  it.each([['zh', '需核对'], ['en', 'Needs checking']] as const)('%s marks an unmappable tool as needing a check without hiding or granting it', async (language, label) => {
    useAppStore.setState({ language });
    invokeDomain.mockImplementation((_domain: string, action: string) => Promise.resolve(action === 'detail' ? detail : []));
    render(<RoleDetailPage roleId="日程管家" />);
    fireEvent.click(await screen.findByTestId('role-detail-tab-skills'));
    const warnings = await screen.findByTestId('role-unknown-tools');
    expect(warnings.textContent).toBe(`fooBar${label}`);
    expect(warnings.querySelector('input')).toBeNull();
    expect(screen.getAllByText('fooBar')).toHaveLength(1);
    await waitFor(() => expect(screen.getByLabelText('Read')).toBeTruthy());
    expect((screen.getByLabelText('Read') as HTMLInputElement).checked).toBe(true);
    console.log(`expert detail ${language}: fooBar ${label}; one warning, no tool grant control`);
  });
});
