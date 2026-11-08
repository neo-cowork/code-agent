// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('falls back to window.open and hides raw uninstall command behind an advanced fold with a risk hint', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.navigator, { clipboard: { writeText } });
    openExternalLink.mockReturnValue(false);
    render(<InstallGuide />);

    fireEvent.click(screen.getByRole('button', { name: zh.settings.localBridge.installGuide.downloadLatest }));
    expect(window.open).toHaveBeenCalledWith(DOWNLOAD_PAGE_URL, '_blank');

    fireEvent.click(screen.getByRole('button', { name: zh.settings.localBridge.installGuide.updateAndUninstall }));
    expect(screen.getAllByRole('button', { name: zh.settings.localBridge.installGuide.downloadLatest })).toHaveLength(2);
    expect(document.body.textContent).toContain(zh.settings.localBridge.installGuide.uninstallDescription);
    expect(document.body.textContent).not.toContain('sudo rm');
    expect(document.body.textContent).not.toContain('rm -rf');
    expect(document.body.textContent).not.toContain('launchctl');
    expect(document.body.textContent).not.toContain(zh.settings.localBridge.installGuide.uninstallRiskHint);

    fireEvent.click(screen.getByRole('button', { name: zh.settings.localBridge.installGuide.viewManualUninstallSteps }));
    expect(document.body.textContent).toContain(zh.settings.localBridge.installGuide.uninstallRiskHint);
    expect(document.body.textContent).toContain('launchctl unload');
    expect(document.body.textContent).toContain('sudo rm -f /usr/local/bin/code-agent-bridge');
    expect(document.body.textContent).toContain('rm -rf "$HOME/.code-agent-bridge"');

    const codeEl = document.querySelector('code');
    expect(codeEl?.className).toContain('whitespace-pre-wrap');
    expect(codeEl?.className).toContain('break-all');
    expect(codeEl?.className).not.toContain('truncate');

    fireEvent.click(screen.getByTitle(zh.settings.localBridge.installGuide.copyCommand));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        'launchctl unload "$HOME/Library/LaunchAgents/com.code-agent.bridge.plist" 2>/dev/null; sudo rm -f /usr/local/bin/code-agent-bridge; rm -rf "$HOME/.code-agent-bridge"',
      );
      expect(document.body.textContent).toContain(zh.settings.localBridge.installGuide.copied);
    });
  });
});
