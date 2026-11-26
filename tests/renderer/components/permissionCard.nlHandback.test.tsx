// @vitest-environment jsdom
// ============================================================================
// N-PERM-NL-RULES-K2 × 精简审批卡面
// ----------------------------------------------------------------------------
// 普通审批卡的详情里有「本次任务 / 24 小时内都允许」这类常驻授权入口。
// 「交回我亲手做」的卡只有两个出路（我做完了 / 让 Neo 做这一次），不能出现这些入口。
// ============================================================================
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { NL_RULE_K2_TEXT } from '../../../src/shared/nlRuleRestate';

const state = vi.hoisted(() => ({ request: null as PermissionRequest | null }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
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
});

// 带参数预览的卡默认展开，详情区直接在页面上；命令带精确授权目标，所以普通卡会给出常驻授权入口。
function commandRequest(handback: boolean): PermissionRequest {
  return {
    id: handback ? 'k2-handback-card' : 'k2-plain-card',
    sessionId: 'session-current',
    type: 'command',
    tool: 'Bash',
    timestamp: 1,
    argsPreview: 'make release',
    details: { command: 'make release', commandGrantTarget: 'make release' },
    ...(handback ? { handback: true } : {}),
  } as PermissionRequest;
}

describe('交回我亲手做的审批卡不出常驻授权入口', () => {
  it('对照：同一条命令的普通卡，详情里有常驻授权入口', () => {
    state.request = commandRequest(false);
    render(<PermissionCard />);
    const secondary = screen.getByTestId('permission-secondary-choices');
    expect(secondary.querySelectorAll('button').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('handback-note')).toBeNull();
  });

  it('handback 卡：只有两个出路，没有常驻授权入口', () => {
    state.request = commandRequest(true);
    const { container } = render(<PermissionCard />);
    expect(screen.queryByTestId('permission-secondary-choices')).toBeNull();
    expect(screen.getByTestId('handback-note').textContent).toBe(NL_RULE_K2_TEXT.card.note);
    const labels = Array.from(container.querySelectorAll('button')).map((button) => button.textContent ?? '');
    expect(labels.some((label) => label.includes(NL_RULE_K2_TEXT.card.userDidIt))).toBe(true);
    expect(labels.some((label) => label.includes(NL_RULE_K2_TEXT.card.letNeoOnce))).toBe(true);
    expect(container.textContent).toContain(NL_RULE_K2_TEXT.card.title);
  });
});
