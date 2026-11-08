// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

const openExternalLink = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  openExternalLink,
}));

import { InstallGuide } from '../../../src/renderer/components/features/settings/sections/localBridge/InstallGuide';

const DOWNLOAD_PAGE_URL = 'https://agentneo.vercel.app/#download';

describe('InstallGuide', () => {
  beforeEach(() => {
    openExternalLink.mockReset();
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens the download page from a labelled button instead of showing a shell command', () => {
    openExternalLink.mockReturnValue(true);
    render(<InstallGuide />);

    expect(document.body.textContent).not.toContain(`open ${DOWNLOAD_PAGE_URL}`);
    fireEvent.click(screen.getByRole('button', { name: zh.settings.localBridge.installGuide.downloadLatest }));
    expect(openExternalLink).toHaveBeenCalledWith(DOWNLOAD_PAGE_URL);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('falls back to window.open and keeps uninstall as a copyable command', () => {
    openExternalLink.mockReturnValue(false);
    render(<InstallGuide />);

    fireEvent.click(screen.getByRole('button', { name: zh.settings.localBridge.installGuide.downloadLatest }));
    expect(window.open).toHaveBeenCalledWith(DOWNLOAD_PAGE_URL, '_blank');

    fireEvent.click(screen.getByRole('button', { name: zh.settings.localBridge.installGuide.updateAndUninstall }));
    expect(screen.getAllByRole('button', { name: zh.settings.localBridge.installGuide.downloadLatest })).toHaveLength(2);
    expect(document.body.textContent).toContain('launchctl unload');
  });
});
