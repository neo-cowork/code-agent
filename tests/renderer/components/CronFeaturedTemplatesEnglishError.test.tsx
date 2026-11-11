// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const createJob = vi.fn();

vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({ useMcpServerStates: () => [] }));
vi.mock('../../../src/renderer/components/features/cron/cronTemplates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/components/features/cron/cronTemplates')>();
  const { createDefaultCronJobDraft } = await import('../../../src/renderer/components/features/cron/types');
  // A featured template whose generated draft fails validation (empty task name).
  const broken = {
    id: 'broken-featured',
    name: 'Broken',
    emoji: '',
    description: 'Broken template',
    scheduleLabel: 'Daily',
    featured: true,
    fields: [],
    generate: () => ({ ...createDefaultCronJobDraft(), name: '' }),
  };
  return { ...actual, FEATURED_CRON_TEMPLATES: [broken] };
});

import { CronFeaturedTemplates } from '../../../src/renderer/components/features/cron/CronFeaturedTemplates';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

const CJK = /[㐀-鿿＀-￯]/;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.setState({ language: 'zh' });
});

describe('CronFeaturedTemplates validation error language', () => {
  it.each([['en'], ['zh']] as const)('enable with a rejected draft shows localized error (%s)', async (language) => {
    useAppStore.setState({ language });
    useCronStore.setState({ jobs: [], createJob } as never);
    render(<CronFeaturedTemplates />);
    fireEvent.click(screen.getByTestId('cron-featured-broken-featured'));
    const banner = await waitFor(() => {
      const el = document.querySelector('.text-badge-danger');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(createJob).not.toHaveBeenCalled();
    if (language === 'en') expect(banner.textContent).not.toMatch(CJK);
    else expect(banner.textContent).toMatch(CJK);
  });
});
