// @vitest-environment jsdom
// 同一 UI 轮拆成多段 assistant 时，每段都带着同一份 turnQuality。记忆芯片只挂在
// 这一轮的 chip owner 上（结论优先，否则最后一条带记忆的正文），模型徽标和
// 开发者质量条仍留在非 owner 分段。
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract/message';
import type { TurnQualitySummary } from '../../../src/shared/contract/turnQuality';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { invokeMemoryEntryCommand } from '../../../src/renderer/services/invokeMemoryEntryCommand';

vi.mock('../../../src/renderer/services/invokeMemoryEntryCommand', () => ({
  invokeMemoryEntryCommand: vi.fn(async () => ({ success: true, data: { flagged: true } })),
}));

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

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

const MODEL = 'gate-model-77';
const AGENT = '周报助手';

function memorySummary(titles: string[]): TurnQualitySummary {
  return {
    memory: {
      mode: 'auto',
      blocks: [{
        blockType: 'user-memory',
        trigger: 'session_start',
        source: 'memory-packer',
        injected: true,
        chars: 40,
        count: titles.length,
        items: titles.map((title, index) => ({
          entryId: `mem-${index + 1}`,
          title,
          kind: 'user',
          scope: 'global',
          status: 'active',
          preview: title,
        })),
      }],
    },
    strategy: { provider: 'zhipu', model: MODEL, requestedModel: MODEL },
    capabilities: { agentName: AGENT },
    score: { score: 80, max: 100, grade: 'good', breakdown: [] },
  };
}

function assistant(id: string, content: string, timestamp: number, summary: TurnQualitySummary, extra: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content, timestamp, metadata: { turnQuality: summary }, ...extra };
}

function project(messages: Message[], processing = false) {
  const projection = projectTurns(messages, 'session-1', processing);
  expect(projection.turns).toHaveLength(1);
  return projection.turns[0];
}

function memoryChipButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter((button) => (
    (button.textContent || '').includes('参考了')
  ));
}

describe('TurnCard 记忆芯片每轮只出现一次', () => {
  beforeEach(() => {
    useAppStore.setState({ developerMode: false, disclosureLevel: 'standard', language: 'zh' });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ developerMode: false, disclosureLevel: 'standard', language: 'zh' });
  });

  it('两段 assistant 都带 user-memory：只有回复正文那一段有一颗芯片，空正文分段仍留模型徽标和代理徽标', () => {
    const summary = memorySummary(['周报分三段']);
    const turn = project([
      { id: 'u1', role: 'user', content: '按我保存的偏好写周报', timestamp: 1_000 },
      assistant('a1', '', 2_000, summary, {
        reasoning: '先看笔记',
        toolCalls: [{
          id: 'tc-1',
          name: 'Read',
          arguments: { path: 'notes.txt' },
          result: { toolCallId: 'tc-1', success: true, output: '笔记' },
        }],
      }),
      assistant('a2', '本周周报如下：进展、风险、下周计划。', 3_000, summary),
    ]);
    expect(turn.nodes.filter((node) => node.metadata?.turnQuality).map((node) => node.id)).toEqual([
      'a1-text',
      'a1-tc-tc-1',
      'a2-text',
    ]);
    expect(turn.status).toBe('completed');

    const { container } = render(<TurnCard turn={turn} sessionId="session-1" />);
    const chips = memoryChipButtons(container);
    expect(chips.map((chip) => chip.textContent)).toEqual(['参考了 1 条记忆']);
    const owner = chips[0].closest('[data-trace-node-id]');
    expect(owner?.getAttribute('data-trace-node-id')).toBe('a2-text');
    const ownerText = owner?.textContent || '';
    expect(ownerText.indexOf('参考了')).toBeLessThan(ownerText.indexOf('本周周报如下'));

    const preamble = container.querySelector('[data-trace-node-id="a1-text"]');
    expect(preamble?.textContent).toContain(MODEL);
    expect(preamble?.textContent).toContain(AGENT);
    expect(preamble?.textContent).not.toContain('参考了');
  });

  it('完成后折起：芯片仍只有一颗，留在最终正文上方', () => {
    useAppStore.setState({ disclosureLevel: 'simple' });
    const summary = memorySummary(['周报分三段']);
    const turn = project([
      { id: 'u1', role: 'user', content: '按我保存的偏好写周报', timestamp: 1_000 },
      assistant('a1', '', 2_000, summary, {
        reasoning: '先看笔记',
        toolCalls: [{
          id: 'tc-1',
          name: 'Read',
          arguments: { path: 'notes.txt' },
          result: { toolCallId: 'tc-1', success: true, output: '笔记' },
        }],
      }),
      assistant('a2', '本周周报如下：进展、风险、下周计划。', 3_000, summary),
    ]);

    const { container } = render(<TurnCard turn={turn} sessionId="session-1" />);
    expect(container.querySelector('[data-trace-node-id="a1-text"]')).toBeNull();
    const chips = memoryChipButtons(container);
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain('参考了 1 条记忆');
    const owner = chips[0].closest('[data-trace-node-id]');
    expect(owner?.getAttribute('data-trace-node-id')).toBe('a2-text');
    const ownerText = owner?.textContent || '';
    expect(ownerText.indexOf('参考了')).toBeLessThan(ownerText.indexOf('本周周报如下'));
  });

  it('单段回复仍显示一颗芯片，条数等于记忆列表长度', () => {
    const summary = memorySummary(['周报分三段', '受众是团队']);
    const turn = project([
      { id: 'u1', role: 'user', content: '写周报', timestamp: 1_000 },
      assistant('a1', '周报正文。', 2_000, summary),
    ]);
    const { container } = render(<TurnCard turn={turn} sessionId="session-1" />);
    const chips = memoryChipButtons(container);
    expect(chips.map((chip) => chip.textContent)).toEqual(['参考了 2 条记忆']);
    fireEvent.click(chips[0]);
    expect(container.textContent).toContain('周报分三段');
    expect(container.textContent).toContain('受众是团队');
  });

  it('开发者模式的质量条在非 owner 分段照常渲染', () => {
    const summary = memorySummary(['周报分三段']);
    const turn = project([
      { id: 'u1', role: 'user', content: '按我保存的偏好写周报', timestamp: 1_000 },
      assistant('a1', '', 2_000, summary, { reasoning: '先看笔记' }),
      assistant('a2', '本周周报如下。', 3_000, summary),
    ]);
    useAppStore.setState({ developerMode: true });
    const { container } = render(<TurnCard turn={turn} sessionId="session-1" />);
    const preamble = container.querySelector('[data-trace-node-id="a1-text"]');
    const reply = container.querySelector('[data-trace-node-id="a2-text"]');
    expect(preamble?.querySelector('button[title="展开本轮质量信息"]')).toBeTruthy();
    expect(reply?.querySelector('button[title="展开本轮质量信息"]')).toBeTruthy();
    expect(memoryChipButtons(container)).toHaveLength(0);
  });

  it('正文还没落地时芯片挂在最后一条带记忆的分段，正文到达后挪到回复上', () => {
    const summary = memorySummary(['周报分三段']);
    const user: Message = { id: 'u1', role: 'user', content: '按我保存的偏好写周报', timestamp: 1_000 };
    const drafting = assistant('a1', '', 2_000, summary, {
      reasoning: '先看笔记',
      toolCalls: [{
        id: 'tc-1',
        name: 'Read',
        arguments: { path: 'notes.txt' },
      }],
    });
    const { container, rerender } = render(
      <TurnCard turn={project([user, drafting], true)} sessionId="session-1" isSessionProcessing />,
    );
    expect(memoryChipButtons(container).map((chip) => chip.closest('[data-trace-node-id]')?.getAttribute('data-trace-node-id'))).toEqual(['a1-text']);

    rerender(
      <TurnCard
        turn={project([user, drafting, assistant('a2', '本周周报如下。', 3_000, summary)])}
        sessionId="session-1"
      />,
    );
    const chips = memoryChipButtons(container);
    expect(chips).toHaveLength(1);
    expect(chips[0].closest('[data-trace-node-id]')?.getAttribute('data-trace-node-id')).toBe('a2-text');
  });
});

// N-MEM-SOURCE-WRONG-FEEDBACK：展开后的每行记忆给「不对 / 过时了」，点了乐观置灰 + 撤销。
describe('MemorySourceChip 行级负反馈（不对/过时了）', () => {
  beforeEach(() => {
    useAppStore.setState({ developerMode: false, disclosureLevel: 'standard', language: 'zh' });
    vi.mocked(invokeMemoryEntryCommand).mockClear();
    vi.mocked(invokeMemoryEntryCommand).mockResolvedValue({ success: true, data: { flagged: true } });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ developerMode: false, disclosureLevel: 'standard', language: 'zh' });
  });

  function renderExpanded(titles: string[]) {
    const summary = memorySummary(titles);
    const turn = project([
      { id: 'u1', role: 'user', content: '写周报', timestamp: 1_000 },
      assistant('a1', '周报正文。', 2_000, summary),
    ]);
    const { container } = render(<TurnCard turn={turn} sessionId="session-1" />);
    fireEvent.click(memoryChipButtons(container)[0]);
    return container;
  }

  it('① 每行都有「不对」「过时了」两个动作', () => {
    const container = renderExpanded(['周报分三段', '受众是团队']);
    const rows = container.querySelectorAll('[data-testid="memory-source-rows"] > li');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.textContent).toContain('不对');
      expect(row.textContent).toContain('过时了');
    }
  });

  it('① 点「不对」：行置灰出「已停用 · 你标记为不对」+ 撤销，不再显示两个动作', () => {
    const container = renderExpanded(['周报分三段']);
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === '不对')!);
    expect(invokeMemoryEntryCommand).toHaveBeenCalledWith(
      { action: 'memoryEntryFlagInjection', entryId: 'mem-1', flag: 'wrong' },
    );
    const row = container.querySelector('[data-testid="memory-source-rows"] > li')!;
    expect(row.textContent).toContain('已停用 · 你标记为不对');
    expect(row.textContent).toContain('撤销');
    expect(row.textContent).not.toContain('过时了');
    expect(row.className).toContain('opacity-60');
  });

  it('① 点「过时了」标记 outdated；撤销调 clearFlag 后动作回到两个', async () => {
    const container = renderExpanded(['周报分三段']);
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === '过时了')!);
    expect(invokeMemoryEntryCommand).toHaveBeenLastCalledWith(
      { action: 'memoryEntryFlagInjection', entryId: 'mem-1', flag: 'outdated' },
    );
    vi.mocked(invokeMemoryEntryCommand).mockResolvedValueOnce({ success: true, data: { cleared: true } });
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === '撤销')!);
    expect(invokeMemoryEntryCommand).toHaveBeenLastCalledWith(
      { action: 'memoryEntryClearInjectionFlag', entryId: 'mem-1' },
    );
    const row = container.querySelector('[data-testid="memory-source-rows"] > li')!;
    expect(row.textContent).toContain('不对');
    expect(row.textContent).toContain('过时了');
    expect(row.textContent).not.toContain('已停用');
  });

  it('① host 写失败时回滚乐观状态（动作回到两个）', async () => {
    vi.mocked(invokeMemoryEntryCommand).mockResolvedValueOnce({ success: true, data: { flagged: false } });
    const container = renderExpanded(['周报分三段']);
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === '不对')!);
    await vi.waitFor(() => {
      const row = container.querySelector('[data-testid="memory-source-rows"] > li')!;
      expect(row.textContent).toContain('过时了');
      expect(row.textContent).not.toContain('已停用');
    });
  });

  it('r1 回滚不静默：行上留「没标记上，请重试」，重试成功后提示消失', async () => {
    vi.mocked(invokeMemoryEntryCommand)
      .mockResolvedValueOnce({ success: true, data: { flagged: false } })
      .mockResolvedValueOnce({ success: true, data: { flagged: true } });
    const container = renderExpanded(['周报分三段']);
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === '不对')!);
    await vi.waitFor(() => {
      const row = container.querySelector('[data-testid="memory-source-rows"] > li')!;
      expect(row.textContent).toContain('没标记上，请重试');
      expect(row.textContent).not.toContain('已停用');
    });
    // 重试：动作还在（回滚后回到两个），再点一次成功 → 置灰、提示消失
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === '不对')!);
    await vi.waitFor(() => {
      const row = container.querySelector('[data-testid="memory-source-rows"] > li')!;
      expect(row.textContent).toContain('已停用 · 你标记为不对');
      expect(row.textContent).not.toContain('没标记上，请重试');
    });
  });
});
