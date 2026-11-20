// @vitest-environment jsdom
// ============================================================================
// N-FIX-EN-UI-HARDCODED-ZH-SYSTEMIC-FU4-REDESIGN-FU1 — 同一挂载里把语言
// en → zh → en 实时拨过去，三个面上的内置专家名必须跟着走，不许残留拼音：
//   · 语音派活任务卡 speaker 章（TurnCard → VoiceDispatchCardHeader）
//   · 首次醒来卡头像（RoleFirstWakeCard，名字进 aria-label/title）
//   · 主对话补话回执条（MemberInputNote，存的是原始名/原始职称）
// 既有用例都是「en 挂一次、zh 挂一次」两次挂载；本文件钉生产真实路径——
// Settings 里 setLanguage 之后不重启不重挂，旧名字必须被顶掉。
// ============================================================================
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceNode, TraceTurn } from '../../../src/shared/contract/trace';
import type { RoleFirstWakeSnapshot, RolePanelEntry } from '../../../src/shared/contract/roleAssets';

// ---- mock 沿自 turnCard.voiceDispatch.test.tsx（TurnCard 渲染所需的最小 store） ----
vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const state = { currentSessionId: 'session-1', sessions: [], messages: [], runningSessionIds: new Set<string>() };
  const useSessionStore = (selector?: (value: typeof state) => unknown) => (
    selector ? selector(state) : state
  );
  useSessionStore.getState = () => state;
  return { useSessionStore };
});

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    createForkFromReply: vi.fn(),
    sendPrompt: vi.fn(),
  }),
}));

// ---- mock 沿自 RoleFirstWakeCard.test.tsx（首次醒来卡的 rolesClient 面） ----
const getFirstWake = vi.fn<(roleId: string) => Promise<RoleFirstWakeSnapshot | null>>();
const consumeFirstWakeSuggestion = vi.fn<(roleId: string, title: string) => Promise<{ success: boolean }>>();
const skipFirstWake = vi.fn<(roleId: string) => Promise<{ success: boolean }>>();
const retryFirstWake = vi.fn<(roleId: string) => Promise<{ retried: boolean }>>();
const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const listWakeProposals = vi.fn<(roleId: string) => Promise<unknown[]>>(() => Promise.resolve([]));
const goToExpertThread = vi.fn<(roleId: string, options?: { seed?: string }) => Promise<void>>();
const invokeDomain = vi.fn();

vi.mock('../../../src/renderer/services/rolesClient', () => ({
  getFirstWake: (roleId: string) => getFirstWake(roleId),
  consumeFirstWakeSuggestion: (roleId: string, title: string) => consumeFirstWakeSuggestion(roleId, title),
  skipFirstWake: (roleId: string) => skipFirstWake(roleId),
  retryFirstWake: (roleId: string) => retryFirstWake(roleId),
  listRoles: () => listRoles(),
  listWakeProposals: (roleId: string) => listWakeProposals(roleId),
  acceptWakeProposal: vi.fn(),
  dismissWakeProposal: vi.fn(),
}));

vi.mock('../../../src/renderer/utils/inviteExpert', () => ({
  goToExpertThread: (...args: unknown[]) => goToExpertThread(...(args as [string, { seed?: string }?])),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: () => () => {},
    invoke: vi.fn().mockResolvedValue(null),
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
  },
}));

import { useAppStore } from '../../../src/renderer/stores/appStore';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { RoleFirstWakeCard } from '../../../src/renderer/components/features/chat/RoleFirstWakeCard';
import { MemberInputNote } from '../../../src/renderer/components/features/expert/MemberInputNote';

// 与生产 resolveNarrationSpeaker / listRoles 的形状对齐：内置专家的 roleId 与
// displayName 都是原始中文名，拼音只在渲染时按当前语言映射出来。
const BUILTIN_ROLE: RolePanelEntry = {
  roleId: '牧之',
  description: '',
  source: 'builtin',
  memoryCount: 0,
  lastWork: null,
  displayName: '牧之',
};

function voiceTaskTurn(): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-voice-1',
    status: 'completed',
    startTime: 1_000,
    endTime: 9_000,
    nodes: [
      {
        id: 'voice-dispatch-1',
        messageId: 'voice-dispatch-1',
        type: 'assistant_text',
        content: '改写后的派活指令全文',
        timestamp: 1_000,
        metadata: {
          voiceDispatch: {
            title: '建 test3.txt',
            speaker: { agentId: '牧之', displayName: '牧之' },
          },
        },
      },
      {
        id: 'a2-text',
        messageId: 'a2',
        type: 'assistant_text',
        content: '已创建 test3.txt。',
        timestamp: 9_000,
      },
    ],
  } as TraceTurn;
}

// 回执条存的是用户当时看到的原始名字：可能是专家名（牧之），也可能是职称
// （资深产品经理）——两种存量英文界面都得认出来。
function memberNoteNode(memberName: string): TraceNode {
  return {
    id: `note-${memberName}`,
    messageId: `msg-${memberName}`,
    type: 'assistant_text',
    content: 'add page numbers',
    timestamp: 1,
    metadata: { memberInput: { memberId: 'muzhi-1', memberName, mode: 'supplement' } },
  };
}

beforeEach(() => {
  getFirstWake.mockReset().mockResolvedValue({
    state: 'completed',
    sourcesMode: 'none',
    suggestions: [],
    intro: '日历连上了，共 6 个，主要是 Home 和 Work。',
  });
  consumeFirstWakeSuggestion.mockReset().mockResolvedValue({ success: true });
  skipFirstWake.mockReset().mockResolvedValue({ success: true });
  retryFirstWake.mockReset().mockResolvedValue({ retried: true });
  listRoles.mockReset().mockResolvedValue([BUILTIN_ROLE]);
  listWakeProposals.mockReset().mockResolvedValue([]);
  goToExpertThread.mockReset().mockResolvedValue(undefined);
  invokeDomain.mockReset();
  useAppStore.getState().setLanguage('en');
});

afterEach(() => {
  cleanup();
  useAppStore.getState().setLanguage('zh');
});

describe('内置专家名 · 同一挂载里实时切语言', () => {
  it('en 显示拼音 → setLanguage(\'zh\') 后同三处显示中文且容器里无拼音残留 → 拨回 en 拼音回来', async () => {
    const { container } = render(
      <>
        <TurnCard turn={voiceTaskTurn()} sessionId="session-1" />
        <RoleFirstWakeCard roleId="牧之" />
        <MemberInputNote node={memberNoteNode('牧之')} />
        <MemberInputNote node={memberNoteNode('资深产品经理')} />
      </>,
    );

    const avatar = () => container.querySelector('[data-testid="role-first-wake-card"] [role="img"]');
    const notes = () => screen.getAllByTestId('member-input-note');

    // —— en：speaker 章、头像无障碍名、两条回执都走拼音/英文名 ——
    await waitFor(() => expect(screen.getByTestId('voice-task-speaker').textContent).toBe('Muzhi'));
    await waitFor(() => {
      expect(avatar()?.getAttribute('aria-label')).toBe('Muzhi');
      expect(avatar()?.getAttribute('title')).toBe('Muzhi');
    });
    expect(notes()[0].textContent).toContain('Muzhi');
    expect(notes()[1].textContent).toContain('Senior Product Manager');

    // —— 生产动作实时切 zh：不重挂、不改 props ——
    act(() => { useAppStore.getState().setLanguage('zh'); });
    await waitFor(() => expect(screen.getByTestId('voice-task-speaker').textContent).toBe('牧之'));
    await waitFor(() => {
      expect(avatar()?.getAttribute('aria-label')).toBe('牧之');
      expect(avatar()?.getAttribute('title')).toBe('牧之');
    });
    expect(notes()[0].textContent).toContain('牧之');
    expect(notes()[1].textContent).toContain('资深产品经理');
    // innerHTML 连属性一起查：切完不许有任何英文名字残留
    expect(container.innerHTML).not.toContain('Muzhi');
    expect(container.innerHTML).not.toContain('Senior Product Manager');

    // —— 再拨回 en：防粘性状态（名字必须能跟着来回走）——
    act(() => { useAppStore.getState().setLanguage('en'); });
    await waitFor(() => expect(screen.getByTestId('voice-task-speaker').textContent).toBe('Muzhi'));
    await waitFor(() => {
      expect(avatar()?.getAttribute('aria-label')).toBe('Muzhi');
      expect(avatar()?.getAttribute('title')).toBe('Muzhi');
    });
    expect(notes()[0].textContent).toContain('Muzhi');
    expect(notes()[1].textContent).toContain('Senior Product Manager');
  });
});
