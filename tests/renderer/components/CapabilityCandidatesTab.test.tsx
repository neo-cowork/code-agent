// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invoke } }));

import { CapabilityCandidatesTab } from '../../../src/renderer/components/features/capabilityHub/CapabilityCandidatesTab';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const record = {
  clusterKey: 'candidate-a', shapeTokens: ['bash:screencapture', 'write_file'],
  variants: ['bash:screencapture → write_file'], occurrences: 3, avgSteps: 3,
  avgTokens: 0, firstSeenAt: Date.now(), tier: 'skill', aboveFold: true,
  signals: { degraded: false, missingDependency: false },
  summary: 'Capture receipts and organize their information into a complete spreadsheet for a weekly expense report.',
};

afterEach(() => { cleanup(); vi.clearAllMocks(); useAppStore.setState({ language: 'zh' }); });

describe('candidate presentation', () => {
  it.each(['en', 'zh'] as const)('hides raw tool identifiers in named and unnamed rows (%s)', async (language) => {
    useAppStore.setState({ language });
    invoke.mockResolvedValue({ candidates: [
      { ...record, displayName: language === 'en' ? 'Organize receipts' : '整理收据' },
      { ...record, clusterKey: 'candidate-b', aboveFold: false, displayName: undefined },
    ], foldedCount: 1 });
    render(<CapabilityCandidatesTab />);
    const row = await screen.findByTestId('capability-candidate-row');
    expect(row.textContent).not.toMatch(/bash:|write_file|screencapture/);
    expect(within(row).getByText(record.summary)).toBeTruthy();
    fireEvent.click(screen.getByTestId('capability-candidates-fold-toggle'));
    const rows = screen.getAllByTestId('capability-candidate-row');
    expect(rows[1].textContent).not.toMatch(/bash:|write_file|screencapture/);
    expect(rows[1].textContent).toContain(language === 'en' ? 'Repeated work' : '重复完成的工作');
  });
});
