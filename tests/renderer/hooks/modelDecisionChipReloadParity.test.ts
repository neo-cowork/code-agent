import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  applyConversationStreamEvent,
  type ConversationStreamState,
} from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { shouldRenderModelDecisionChip } from '../../../src/renderer/components/features/chat/RouteTraceChip';

/**
 * FB-1682 / N-FIX-ROUTE-CHIP-LOST-ON-RELOAD：同一轮的路由 chip 刷新前后必须一致。
 *
 * 夹具来自一次真实运行（dogfood 模型 xiaomi/neohorse-1.5-flash-preview，自动路由 +
 * taskStrategy manual/main → reason=strategy-main，多工具轮）：`streamEvents` 是
 * /api/run 响应流的原始事件（截断脱敏），`persistedMessages` 是同一轮刷新后
 * session:load 返回的持久化形状（中间轮正文不落库、决策全在）。
 *
 * 两条生产入口都必须走到：
 * - 直播：事件流过 applyConversationStreamEvent（草稿/commit 全在这条路上产生）
 * - 重放：持久化形状 JSON round-trip 后直接 projectTurns
 *
 * 计数口径对齐两个真实表面：
 * - live：活动轮是展开的，空正文节点上的 chip 也渲染（TraceNodeRenderer 的
 *   hasRenderableContent 把决策算作可渲染内容）→ 数所有带决策的 assistant_text 节点；
 * - reload：轮次默认折叠，中间节点不挂载，只有带正文的结论节点在折叠外渲染
 *   → 只数有非空正文的节点（真机 DOM 实测口径，见证据档 ①）。
 */
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/routeChipParityRealShapes.json'), 'utf8'),
) as {
  streamEvents: { type: string; data: unknown }[];
  persistedMessages: Message[];
};

function streamHarness(seed: Message[]) {
  let messages = [...seed];
  const state: ConversationStreamState = {
    currentTurnMessageId: null,
    committedAssistantMessageIds: new Set(),
    lastDeltaSeqByTurn: new Map(),
    segmentRedirectByTurn: new Map(),
  };
  const actions = {
    getMessages: () => messages,
    addMessage: (message: Message) => { messages = [...messages, message]; },
    updateMessage: (id: string, updates: Partial<Message>) => {
      messages = messages.map((m) => (m.id === id ? { ...m, ...updates } : m));
    },
    setMessages: (next: Message[]) => { messages = next; },
    queueUpdate: vi.fn(),
    now: () => 1795124447709,
  } as unknown as Parameters<typeof applyConversationStreamEvent>[2];
  return {
    state,
    actions,
    apply: (event: { type: string; data: unknown }) =>
      applyConversationStreamEvent(event as never, state, actions),
    messages: () => messages,
  };
}

function decisionNodes(messages: Message[]) {
  return projectTurns(messages, 'fixture-session', false)
    .turns
    .flatMap((turn) => turn.nodes)
    .filter((node) => node.type === 'assistant_text' && node.modelDecision && shouldRenderModelDecisionChip(node.modelDecision!));
}

/** 直播表面：活动轮展开，空正文节点上的 chip 也渲染。 */
function liveChipCount(messages: Message[]): number {
  return decisionNodes(messages).length;
}

/** 重放表面：轮次默认折叠，只有带正文的节点在折叠外可见。 */
function reloadedChipCount(messages: Message[]): number {
  return decisionNodes(messages).filter((node) => Boolean(node.content?.trim())).length;
}

describe('route chip live/reload parity (real-shape fixture)', () => {
  const seed: Message[] = [fixture.persistedMessages[0]];

  it('live: settled store and every mid-run prefix show the same chip count as the reloaded turn', () => {
    const h = streamHarness(seed);
    let maxMidRunLiveChips = 0;
    for (const event of fixture.streamEvents) {
      h.apply(event);
      maxMidRunLiveChips = Math.max(maxMidRunLiveChips, liveChipCount(h.messages()));
    }
    const settledLiveChips = liveChipCount(h.messages());

    const persistedShape = JSON.parse(JSON.stringify(fixture.persistedMessages)) as Message[];
    const reloadedChips = reloadedChipCount(persistedShape);

    // 直播任何时刻（含每轮 model_decision 刚落地、commit 未到的窗口）不多刷 chip
    expect(maxMidRunLiveChips).toBe(reloadedChips);
    // 直播收敛态 == 刷新重开态（FB-1682 的原始症状）
    expect(settledLiveChips).toBe(reloadedChips);
    expect(reloadedChips).toBe(1);
  });

  it('replay: the surviving chip lands on the content-bearing final reply, not an empty intermediate node', () => {
    const persistedShape = JSON.parse(JSON.stringify(fixture.persistedMessages)) as Message[];
    const carriers = decisionNodes(persistedShape).filter((node) => Boolean(node.content?.trim()));
    expect(carriers).toHaveLength(1);
    expect(carriers[0].content).toContain('neo-demo-workspace');
    expect(carriers[0].modelDecision?.reason).toBe('strategy-main');
  });

  it('live and replay keys agree: the persisted (toolStrategy-bearing) decision dedups against the live (toolStrategy-less) one', () => {
    // 同一轮决策的两个形状：model_decision 事件不带 toolStrategy，commit/落库形状带。
    // 去重键若把工具面算进去，commit 到达瞬间 key 换挡 → 同一轮刷出两枚 chip。
    const liveEvent = fixture.streamEvents.find((e) => e.type === 'model_decision')!.data as Message['modelDecision'];
    const commitDecision = (fixture.streamEvents.find((e) => e.type === 'message')!.data as { modelDecision: Message['modelDecision'] }).modelDecision;
    expect(liveEvent?.toolStrategy).toBeUndefined();
    expect(commitDecision?.toolStrategy).toBeDefined();
    // 把两个形状先后放进同一轮（live 草稿 → commit 覆盖），投影后只剩一枚可见 chip
    const messages: Message[] = [
      fixture.persistedMessages[0],
      {
        id: 'parity-turn-1', role: 'assistant', content: '先看一下这两个文件。', timestamp: 2,
        modelDecision: liveEvent!,
      },
      {
        id: 'parity-turn-2', role: 'assistant', content: '核对完成，内容一致。', timestamp: 3,
        modelDecision: commitDecision!,
      },
    ];
    expect(liveChipCount(messages)).toBe(1);
    expect(reloadedChipCount(messages)).toBe(1);
  });
});
