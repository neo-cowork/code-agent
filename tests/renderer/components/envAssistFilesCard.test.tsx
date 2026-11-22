// @vitest-environment jsdom
// Evidence class: hermetic-protocol. Card text for a notice produced by the production classifier.
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import type { EnvAssistNotice } from '../../../src/shared/contract/envAssist';

const mocks = vi.hoisted(() => ({ language: 'zh', invoke: vi.fn() }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { languages } = await import('../../../src/renderer/i18n');
  return { useI18n: () => ({ t: languages[mocks.language as 'zh' | 'en'], language: mocks.language }) };
});
vi.mock('../../../src/renderer/services/ipcService', () => ({ invokeDomain: mocks.invoke, default: {} }));
import { classifyEnvBlocker } from '../../../src/host/permissions/envAssist/classify';
import { EnvAssistCard } from '../../../src/renderer/components/features/chat/EnvAssistCard';
import { useEnvAssistStore } from '../../../src/renderer/stores/envAssistStore';

const platform = process.platform;
afterEach(() => { cleanup(); Object.defineProperty(process, 'platform', { value: platform }); });
describe('files and folders card', () => {
  it.each(['zh', 'en'])('renders one plain sentence and the settings button (%s)', async (language) => {
    mocks.language = language;
    mocks.invoke.mockReset().mockImplementation(async (_d, action) => action === 'getAvailability' ? { available: true } : { status: 'rejected' });
    useEnvAssistStore.setState({ notices: {} });
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const notice = classifyEnvBlocker({
      toolName: 'Read', sessionId: 's', runId: 'r',
      result: { ok: false, error: `EPERM: operation not permitted, open '${homedir()}/Desktop/a.txt'`, code: 'FS_ERROR' },
    }) as EnvAssistNotice;
    const { container } = render(<EnvAssistCard notice={notice} />);
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1));
    process.stdout.write(`[card ${language}] ${container.textContent}\n`);
    expect(container.textContent).not.toMatch(/EPERM|TCC|Read|\/Users|Desktop\/a\.txt/);
    expect(container.textContent).toContain(language === 'zh' ? '打开文件和文件夹设置' : 'Open Files and Folders settings');
  });
});
