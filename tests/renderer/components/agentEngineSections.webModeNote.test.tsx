// @vitest-environment jsdom
// Web 版执行引擎页：被 Web 模式禁用的控件要带原因；已有的不可用原因不得被覆盖。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AgentEngineDescriptor, AgentEngineSourceDescriptor } from '../../../src/shared/contract/agentEngine';

const webMode = vi.hoisted(() => ({ value: true }));
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => webMode.value }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...a: unknown[]) => invokeDomain(...a) },
}));
const session = vi.hoisted(() => ({
  currentSessionId: 's1',
  sessions: [{ id: 's1', workingDirectory: '/workspace', engine: { kind: 'native' } }],
  updateSessionEngine: vi.fn(),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: (s: typeof session) => unknown) => sel(session),
}));
const app = vi.hoisted(() => ({ workingDirectory: '/workspace' }));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (sel: (s: typeof app) => unknown) => sel(app),
}));
const lang = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: lang.value === 'zh' ? zh : en, language: lang.value }) };
});

import { AgentEngineListSection } from '../../../src/renderer/components/features/settings/tabs/AgentEngineListSection';
import { AgentEngineModelCatalogSection } from '../../../src/renderer/components/features/settings/tabs/AgentEngineModelCatalogSection';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const src = (kind: string, label: string): AgentEngineSourceDescriptor => ({
  manifestId: kind, kind, label, summary: 's', detected: true, selectable: true, authState: 'authenticated',
  modelSelection: 'runtime_catalog', evidence: 'production', credentialOwner: 'official_client', auditNotes: [],
} as AgentEngineSourceDescriptor);
const desc = (kind: string, label: string, o: Partial<AgentEngineDescriptor> = {}): AgentEngineDescriptor => ({
  manifestId: kind, kind, label, summary: 's', installState: 'installed', runtimeState: 'ready', executable: true,
  capabilities: [], defaultPermissionProfile: 'read_only', cwdPolicy: 'workspace_only', riskTier: 'medium',
  detectedAt: 1, modelSelection: 'runtime_catalog', ...o,
} as AgentEngineDescriptor);
const BROKEN = 'broken-cli-reason';

beforeEach(() => {
  webMode.value = true;
  invokeDomain.mockImplementation((_d: string, action: string) => {
    if (action === 'listSources') return Promise.resolve([src('grok_cli', 'GrokX'), src('codebuddy_code', 'BuddyY')]);
    if (action === 'list' || action === 'detect') {
      return Promise.resolve([desc('grok_cli', 'GrokX'), desc('codebuddy_code', 'BuddyY', { executable: false, lastError: BROKEN })]);
    }
    if (action === 'listModels') {
      return Promise.resolve({ source: 'bundled', diagnostics: [], catalog: { version: '1', updatedAt: '2026-01-01', engines: [
        { kind: 'codex_cli', defaultModel: 'm1', models: [{ id: 'm1', label: 'M1', capabilities: [] }] },
      ] } });
    }
    return Promise.resolve({ models: { agentEngines: {} } });
  });
});
afterEach(() => cleanup());

describe.each([['zh', zh], ['en', en]] as const)('agent engine web-mode note (%s)', (language, locale) => {
  const note = locale.settings.webModeBanner.engineManageDesktopOnly;
  beforeEach(() => { lang.value = language; });

  it('web: 引擎切换按钮 title 为说明句，已有不可用原因不被覆盖，可见句出现', async () => {
    const view = render(<AgentEngineListSection />);
    await waitFor(() => expect(screen.getByText('GrokX')).toBeTruthy());
    expect(view.container.textContent).toContain(note);
    const grok = view.container.querySelector('[data-testid="engine-switch-button-grok_cli"]') as HTMLButtonElement;
    const buddy = view.container.querySelector('[data-testid="engine-switch-button-codebuddy_code"]') as HTMLButtonElement;
    expect(grok.disabled).toBe(true);
    expect(grok.getAttribute('title')).toBe(note);
    expect(buddy.disabled).toBe(true);
    expect(buddy.getAttribute('title')).toBe(BROKEN);
  });

  it('web: 默认模型下拉禁用且 title 为说明句，可见句出现', async () => {
    const view = render(<AgentEngineModelCatalogSection />);
    await waitFor(() => expect(view.container.querySelector('select')).toBeTruthy());
    expect(view.container.textContent).toContain(note);
    const sel = view.container.querySelector('select') as HTMLSelectElement;
    expect(sel.disabled).toBe(true);
    expect(sel.getAttribute('title')).toBe(note);
  });

  it('desktop: 无说明句、无 note title', async () => {
    webMode.value = false;
    const list = render(<AgentEngineListSection />);
    await waitFor(() => expect(screen.getByText('GrokX')).toBeTruthy());
    expect(list.container.textContent).not.toContain(note);
    expect(list.container.querySelector('[data-testid="engine-switch-button-grok_cli"]')?.getAttribute('title')).not.toBe(note);
    cleanup();
    const cat = render(<AgentEngineModelCatalogSection />);
    await waitFor(() => expect(cat.container.querySelector('select')).toBeTruthy());
    expect(cat.container.textContent).not.toContain(note);
    expect(cat.container.querySelector('select')?.hasAttribute('title')).toBe(false);
  });
});
