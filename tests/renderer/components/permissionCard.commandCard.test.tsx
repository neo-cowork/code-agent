// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PermissionRequest } from '../../../src/shared/contract';
import { ConfirmationGate } from '../../../src/host/agent/confirmationGate';

const state = vi.hoisted(() => ({
  request: null as PermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({
      t: state.language === 'en' ? en : zh,
      language: state.language,
    }),
  };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: 'session-current',
    setPendingPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (value: { sendPrompt: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ sendPrompt: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';

afterEach(() => {
  cleanup();
  state.request = null;
  state.language = 'zh';
});

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

describe('PermissionCard command de-dup, spawn_agent summary, and long script collapse', () => {
  it('(a) renders bash command text exactly once (interactive and parked with argsPreview)', () => {
    const gate = new ConfirmationGate();
    const command = 'curl -sL https://example.com/api/status | head -n 20';
    const preview = gate.buildPreview('Bash', { command });

    // Interactive card
    state.request = {
      id: 'req-bash-once-1',
      sessionId: 'session-current',
      tool: 'Bash',
      type: 'command',
      details: {
        command,
        preview,
      },
      timestamp: 1,
    };
    const { container, unmount } = render(<PermissionCard />);
    expect(countOccurrences(container.textContent || '', command)).toBe(1);
    const markupWithoutTitle = renderToStaticMarkup(<PermissionCard />).replace(/title="[^"]*"/g, '');
    expect(countOccurrences(markupWithoutTitle, command)).toBe(1);
    unmount();

    // Parked variant with argsPreview
    state.request = {
      id: 'req-bash-once-2',
      sessionId: 'session-current',
      tool: 'Bash',
      type: 'command',
      argsPreview: command,
      details: {
        command,
        preview,
      },
      timestamp: 2,
    };
    const parkedRender = render(<PermissionCard />);
    expect(countOccurrences(parkedRender.container.textContent || '', command)).toBe(1);
    expect(parkedRender.container.querySelector('[data-testid="permission-args-preview"]')).toBeNull();
  });

  it('(b) collapses a 40-line command by default with line hint and expands/collapses via toggle button', () => {
    const lines = Array.from({ length: 40 }, (_, idx) => `echo "step-${idx + 1}-output"`);
    const script = lines.join('\n');
    const gate = new ConfirmationGate();
    state.request = {
      id: 'req-long-script',
      sessionId: 'session-current',
      tool: 'Bash',
      type: 'command',
      details: {
        command: script,
        preview: gate.buildPreview('Bash', { command: script }),
      },
      timestamp: 1,
    };

    const { container } = render(<PermissionCard />);
    const textBefore = container.textContent || '';
    expect(textBefore).toContain('step-1-output');
    expect(textBefore).toContain('step-8-output');
    expect(textBefore).not.toContain('step-9-output');
    expect(textBefore).not.toContain('step-40-output');
    expect(textBefore).toContain('共 40 行，仅展示前 8 行');

    const showAllBtn = screen.getByRole('button', { name: '展开全部' });
    fireEvent.click(showAllBtn);

    const textAfter = container.textContent || '';
    expect(textAfter).toContain('step-9-output');
    expect(textAfter).toContain('step-40-output');

    const collapseBtn = screen.getByRole('button', { name: '收起' });
    fireEvent.click(collapseBtn);
    expect(container.textContent || '').not.toContain('step-40-output');
  });

  it('also collapses a single-line command longer than 400 characters', () => {
    const command = `echo ${'x'.repeat(450)}`;
    state.request = {
      id: 'req-long-single-line',
      sessionId: 'session-current',
      tool: 'Bash',
      type: 'command',
      details: { command },
      timestamp: 1,
    };

    const { container } = render(<PermissionCard />);
    expect(container.textContent).not.toContain(command);
    fireEvent.click(screen.getByRole('button', { name: '展开全部' }));
    expect(container.textContent).toContain(command);
  });

  it('(c) never collapses dangerous_command even when over 40 lines', () => {
    const lines = Array.from({ length: 42 }, (_, idx) => `rm -rf /tmp/build-step-${idx + 1}`);
    const script = lines.join('\n');
    state.request = {
      id: 'req-dangerous-long',
      sessionId: 'session-current',
      tool: 'Bash',
      type: 'dangerous_command',
      details: {
        command: script,
      },
      timestamp: 1,
    };

    const { container } = render(<PermissionCard />);
    const text = container.textContent || '';
    expect(text).toContain('build-step-1');
    expect(text).toContain('build-step-42');
    expect(screen.queryByRole('button', { name: '展开全部' })).toBeNull();
    expect(container.querySelector('[data-testid="permission-command-fold"]')).toBeNull();
  });

  it('(d) renders spawn_agent with generic approval title and role+task summary, not 执行命令 or bare 执行工具 spawn_agent', () => {
    const gate = new ConfirmationGate();
    const params = {
      role: '数据分析师',
      task: '汇总本周销售日报并输出关键异常指标',
    };
    state.request = {
      id: 'req-spawn-agent',
      sessionId: 'session-current',
      tool: 'spawn_agent',
      type: 'command',
      details: {
        ...params,
        preview: gate.buildPreview('spawn_agent', params),
      },
      timestamp: 1,
    };

    const { container, unmount } = render(<PermissionCard />);
    const textZh = container.textContent || '';
    expect(textZh).toContain('需要你确认');
    expect(textZh).not.toContain('执行命令');
    expect(textZh).toContain('派出子代理（数据分析师）：汇总本周销售日报并输出关键异常指标');
    expect(textZh).not.toContain('执行工具 spawn_agent');
    unmount();

    // Also verify English title
    state.language = 'en';
    const enRender = render(<PermissionCard />);
    const textEn = enRender.container.textContent || '';
    expect(textEn).toContain('Needs your approval');
    expect(textEn).toContain('派出子代理（数据分析师）：汇总本周销售日报并输出关键异常指标');
  });
});
