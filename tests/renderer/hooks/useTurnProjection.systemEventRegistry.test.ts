// ============================================================================
// 用户可见 system 事件登记制（P0-2）契约测试
//
// 守的是 #908 那道缺口的泛化修复：role:'system' 消息「谁该给用户看」由写入侧
// 登记表（shared/contract/systemEventRegistry）决定，投影层只查表。
//
// - 表驱动用例：登记表每一项自动生成一条用例，加一项自动多一条（本文件的
//   SAMPLE_PAYLOADS 是登记键的全量映射，加了登记项没补样本 = 编译期报错）。
// - 底线用例：裸 role:'system'（无 metadata）仍被总闸跳过——真库 635 条内部
//   指令不外泄，这是本工单不可回归的底线。
// - 哨兵用例：带未登记「事件性」metadata 键的 system 消息，开发档 console.error
//   （生产档维持现状跳过，线上行为不变）。
//
// 变异验证（摘登记表项 → 红）由事件级测试兜底：摘掉 voiceCallFailure 后
// useTurnProjection.voiceCallFailure.test.ts 转红（双向结果见施工报告）。
// ============================================================================
import { describe, expect, it, vi } from 'vitest';
import type { Message, MessageMetadata } from '../../../src/shared/contract';
import {
  USER_VISIBLE_SYSTEM_EVENT_REGISTRY,
  type UserVisibleSystemEventKey,
  type UserVisibleSystemEventSpec,
} from '../../../src/shared/contract/systemEventRegistry';
import { buildTurnRailItems } from '../../../src/renderer/utils/turnRailItems';
import { buildRunUiState } from '../../../src/renderer/utils/runWorkbenchProjection';
import { applyStreamingMessageDeltasToProjection } from '../../../src/renderer/utils/streamingProjectionOverlay';
import { applyVoicePartialsToProjection } from '../../../src/renderer/utils/voicePartialOverlay';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

const SESSION_ID = 'session-1';
const WORK_ITEM_ID = 'wi-1';

/**
 * 每个登记键一份合法样本 payload。类型是「登记键 ⇒ MessageMetadata 对应值」的
 * 全量映射：登记表加一项而这里没补样本 = 编译期报错；键拼错同样编译期报错。
 */
const SAMPLE_PAYLOADS: { [K in UserVisibleSystemEventKey]: NonNullable<MessageMetadata[K]> } = {
  voiceCallSummary: {
    durationSec: 61,
    provider: 'openai-realtime',
    conversationModel: 'gpt-realtime',
    workItemCount: 1,
    startedAt: 1_000,
    endedAt: 2_000,
    transcriptCount: 4,
  },
  voiceCallFailure: {
    code: 'UPSTREAM_SOCKET',
    phase: 'upstream',
    timestamp: 9_000,
    neoSessionId: SESSION_ID,
  },
  voiceWorkFailure: { workItemId: WORK_ITEM_ID, title: '买菜' },
  voiceWorkSettled: { workItemId: WORK_ITEM_ID, title: '买菜', outcome: 'done' },
  agentRecoveryNotice: { kind: 'vision_tool_unsupported' },
  roleFlowStalled: { skillName: 'create-role' },
  roleEditReceipt: { roleId: '研究员', addedTools: ['calendar'], removedTools: [], descriptionChanged: false, promptChanged: false },
  backgroundWakeFailed: { taskId: 'session-work-1', reason: 'wake_failed' },
  backgroundTaskInterrupted: { taskId: 'session-work-1' },
  turnCheckoutNote: {
    operation: 'checkout',
    state: 'success',
    done: ['workspace', 'conversation', 'manifest', 'evidence'],
    failed: [],
    skippedFiles: [],
    changedFileCount: 2,
    externalSideEffectsWarning: 'Changes caused by external commands are not rolled back.',
  },
};

function systemEventMessage<K extends UserVisibleSystemEventKey>(key: K): Message {
  return {
    id: `sys-${key}`,
    role: 'system',
    content: `事件 ${key} 的用户可见正文`,
    timestamp: 9_000,
    metadata: {
      source: 'voice',
      [key]: SAMPLE_PAYLOADS[key],
      ...(key === 'backgroundTaskInterrupted' ? {
        backgroundTaskResult: {
          source: 'agent-result', taskId: 'session-work-1', shortName: '任务', status: 'failed',
          summary: `事件 ${key} 的用户可见正文`,
        },
      } : {}),
    },
  } as Message;
}

/** 一条 voiceDispatch 派活轮 + 之后另开的一轮——matched-turn 事件必须盖回/挂回派活轮。 */
function dispatchThenLaterTurn(): Message[] {
  return [
    {
      id: 'u-dispatch',
      role: 'user',
      content: '帮我买菜',
      timestamp: 1_000,
      isMeta: true,
      metadata: { voiceDispatch: { title: '买菜', workItemId: WORK_ITEM_ID } },
    } as Message,
    { id: 'a-dispatch', role: 'assistant', content: '好，已派出', timestamp: 2_000 },
    { id: 'u-later', role: 'user', content: '另外说个事', timestamp: 5_000 },
  ];
}

function plainTurn(): Message[] {
  return [
    { id: 'u1', role: 'user', content: '在忙', timestamp: 1_000 },
    { id: 'a1', role: 'assistant', content: '嗯', timestamp: 2_000 },
  ];
}

function project(messages: Message[]) {
  return projectTurns(messages, SESSION_ID, false).turns;
}

describe('用户可见 system 事件登记制（P0-2）', () => {
  it('keeps persisted input redirect receipts internal to inspector data', () => {
    const messages: Message[] = [
      ...plainTurn(),
      {
        id: 'sys-input-redirect',
        role: 'system',
        content: '已按你的纠正改了方向',
        timestamp: 9_000,
        metadata: {
          inputRedirectReceipt: {
            receiptId: 'sys-input-redirect',
            originalContent: '改用更简洁的结构',
            expectedTurnId: 'turn-1',
            partial: { charCount: 88, trailingText: '写到这里' },
            interruptedTools: ['Bash'],
          },
        },
      },
    ];

    const nodes = project(messages).flatMap((turn) => turn.nodes);
    expect(nodes.some((node) => node.id === 'sys-input-redirect')).toBe(false);
  });

  it('生产落库形状的 isMeta voiceDispatch 成卡且不冒充用户消息', () => {
    const turns = project(dispatchThenLaterTurn());
    const dispatchNode = turns
      .flatMap((turn) => turn.nodes)
      .find((node) => node.metadata?.voiceDispatch?.workItemId === WORK_ITEM_ID);

    expect(dispatchNode).toMatchObject({ id: 'u-dispatch', type: 'assistant_text' });
  });

  // 表驱动：登记表里的每一项自动生成一条用例——新增登记项自动多一条覆盖，
  // 不许写成四条手抄用例。
  const entries = Object.entries(USER_VISIBLE_SYSTEM_EVENT_REGISTRY) as [
    UserVisibleSystemEventKey,
    UserVisibleSystemEventSpec,
  ][];
  for (const [key, spec] of entries) {
    it(`登记项 ${key}（presentation=${spec.presentation}, attach=${spec.attach}）按表投影`, () => {
      const messages: Message[] = [
        ...(spec.attach === 'matched-turn' ? dispatchThenLaterTurn() : plainTurn()),
        systemEventMessage(key),
      ];
      const turns = project(messages);
      const allNodes = turns.flatMap((turn) => turn.nodes);

      if (spec.presentation === 'settle') {
        // settle 不成节点：消息本身不投出任何节点，只把结局盖到派活轮上。
        expect(allNodes.some((node) => node.id === `sys-${key}`)).toBe(false);
        const dispatchTurn = turns.find((turn) => (
          turn.nodes.some((node) => node.metadata?.voiceDispatch?.workItemId === WORK_ITEM_ID)
        ));
        expect(dispatchTurn?.voiceWorkOutcome).toBe('done');
        return;
      }

      const node = allNodes.find((n) => n.id === `sys-${key}`);
      expect(node, `登记项 ${key} 必须投出节点`).toBeDefined();
      expect(node?.type).toBe('system');
      // subtype 由登记表给出——失败要看得出是失败（error），摘要要是摘要。
      expect(node?.subtype).toBe(spec.subtype);
      expect(node?.content).toBe(`事件 ${key} 的用户可见正文`);
      expect(node?.metadata?.[key]).toEqual(SAMPLE_PAYLOADS[key]);

      if (spec.attach === 'standalone') {
        expect(turns).toHaveLength(2);
        expect(turns[0]).toEqual(project(plainTurn())[0]);
        expect(turns[1]).toMatchObject({ standalone: true, status: 'completed', nodes: [node] });
      }
      if (spec.attach === 'matched-turn') {
        // 派活轮之后另开过一轮，事件仍要挂回派活轮，不挂到最新轮上。
        const hostTurn = turns.find((turn) => turn.nodes.some((n) => n.id === `sys-${key}`));
        expect(
          hostTurn?.nodes.some((n) => n.metadata?.voiceDispatch?.workItemId === WORK_ITEM_ID),
        ).toBe(true);
      }
    });
  }

  it('appends an edit receipt after the completed answer without changing that turn', () => {
    const before = project(plainTurn());
    const turns = project([...plainTurn(), systemEventMessage('roleEditReceipt')]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual(before[0]);
    expect(turns[1]).toMatchObject({ standalone: true, nodes: [{ id: 'sys-roleEditReceipt' }] });
    expect(buildTurnRailItems(turns)).toEqual(buildTurnRailItems(before));
  });

  it('starts the next user turn after the receipt and keeps it active', () => {
    const messages: Message[] = [...plainTurn(), systemEventMessage('roleEditReceipt'),
      { id: 'u2', role: 'user', content: 'Summarize the industry headlines', timestamp: 10_000 }];
    const projection = projectTurns(messages, SESSION_ID, true);
    expect(projection.turns.map((turn) => turn.nodes[0].id)).toEqual(['u1', 'sys-roleEditReceipt', 'u2']);
    expect(projection.activeTurnIndex).toBe(2);
    expect(buildTurnRailItems(projection.turns).map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-3']);
  });

  it('projects a receipt with no earlier turn as an inactive standalone entry', () => {
    const projection = projectTurns([systemEventMessage('roleEditReceipt')], SESSION_ID, true);
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]).toMatchObject({ standalone: true, status: 'completed' });
    expect(projection.activeTurnIndex).toBe(-1);
    expect(buildTurnRailItems(projection.turns)).toEqual([]);
  });

  it('keeps later assistant messages and current-turn events on the conversational turn', () => {
    const turns = project([...plainTurn(), systemEventMessage('roleEditReceipt'),
      systemEventMessage('roleFlowStalled'),
      { id: 'a2', role: 'assistant', content: 'Your draft is ready.', timestamp: 10_000 }]);
    expect(turns).toHaveLength(2);
    expect(turns[0].nodes.map((node) => node.id)).toEqual(['u1', 'a1-text', 'sys-roleFlowStalled', 'a2-text']);
    expect(turns[1].nodes.map((node) => node.id)).toEqual(['sys-roleEditReceipt']);
  });

  it('keeps workbench, streaming fallback and voice overlays off the receipt', () => {
    const messages = [...plainTurn(), systemEventMessage('roleEditReceipt')];
    const idle = projectTurns(messages, SESSION_ID, false);
    const active = projectTurns(messages, SESSION_ID, true);
    expect(active.activeTurnIndex).toBe(0);
    expect(active.turns[1].status).toBe('completed');
    expect(buildRunUiState({ projection: idle, sessionId: SESSION_ID })).toEqual(
      buildRunUiState({ projection: projectTurns(plainTurn(), SESSION_ID, false), sessionId: SESSION_ID }),
    );
    const overlaid = applyStreamingMessageDeltasToProjection(idle, [
      ...messages, { id: 'pending', role: 'assistant', content: '', timestamp: 10_000 },
    ], { pending: { contentDelta: 'More details', reasoningDelta: '', updatedAt: 10_000 } });
    expect(overlaid.turns[0].nodes.at(-1)?.content).toBe('More details');
    expect(overlaid.turns[1]).toEqual(idle.turns[1]);
    const voice = applyVoicePartialsToProjection(idle, { live: true, user: 'Next topic', assistant: '', startedAt: 10_000 });
    expect(voice.activeTurnIndex).toBe(2);
    expect(voice.turns[1]).toEqual(idle.turns[1]);
  });

  it.each(['done', 'unverified', 'failed', 'cancelled'] as const)(
    '生产落库形状的 settlement %s 按 workItemId 对回同一张卡',
    (outcome) => {
      const messages = [
        ...dispatchThenLaterTurn(),
        {
          id: `settlement-${outcome}`,
          role: 'system',
          content: `任务终态 ${outcome}`,
          timestamp: 9_000,
          metadata: {
            source: 'voice',
            voiceWorkSettled: { workItemId: WORK_ITEM_ID, title: '买菜', outcome },
          },
        } as Message,
      ];

      const turns = project(messages);
      const dispatchTurn = turns.find((turn) => (
        turn.nodes.some((node) => node.metadata?.voiceDispatch?.workItemId === WORK_ITEM_ID)
      ));
      expect(dispatchTurn?.voiceWorkOutcome).toBe(outcome);
      expect(turns.flatMap((turn) => turn.nodes).some((node) => node.id === `settlement-${outcome}`)).toBe(false);
    },
  );

  it('同一条登记事件消息（同 id）被送达两次 → 只投一个节点', () => {
    const sys = systemEventMessage('roleFlowStalled');
    const nodes = project([...plainTurn(), sys, { ...sys }]).flatMap((turn) => turn.nodes);
    expect(nodes.filter((node) => node.id === 'sys-roleFlowStalled')).toHaveLength(1);
  });

  it('backgroundWakeFailed 两种原因（wake_failed / owner_missing）都投出平实 system 节点，不生成 agentError 失败卡', () => {
    const spec: UserVisibleSystemEventSpec = USER_VISIBLE_SYSTEM_EVENT_REGISTRY.backgroundWakeFailed;
    for (const reason of ['wake_failed', 'owner_missing'] as const) {
      const turns = project([
        ...plainTurn(),
        {
          id: `wake-note-${reason}`,
          role: 'system',
          content: '后台任务「报告」已结束，结果见上方的任务结果；自动汇报这一步没能完成，需要的话可以直接问我。',
          timestamp: 9_000,
          metadata: { backgroundWakeFailed: { taskId: 'task-1', reason } },
        } satisfies Message,
      ]);
      const allNodes = turns.flatMap((turn) => turn.nodes);
      const note = allNodes.find((n) => n.id === `wake-note-${reason}`);
      expect(note).toMatchObject({
        type: 'system',
        subtype: spec.subtype,
        metadata: { backgroundWakeFailed: { taskId: 'task-1', reason } },
      });
      expect(note?.subtype).not.toBe('error');
      expect(allNodes.some((n) => Boolean(n.metadata?.agentError))).toBe(false);
    }
  });

  it.each([
    '应用重启时这个后台任务还没做完，已被中断，结果没能送回这里。需要的话请重新发起。',
    'The app restarted while this background task was still running, so it was interrupted and its result could not be delivered. Please start it again if you still need it.',
  ])('projects only the readable interruption sentence: %s', (summary) => {
    const content = `[任务结果] 网页标题｜failed｜${summary}`;
    const message = {
      id: 'session-task-result-interrupted-task-1', role: 'system', content, timestamp: 9_000,
      metadata: {
        backgroundTaskInterrupted: { taskId: 'task-1' },
        backgroundTaskResult: { source: 'agent-result', taskId: 'task-1', shortName: '网页标题', status: 'failed', summary },
      },
    } satisfies Message;
    const turns = project([...plainTurn(), message, message]);
    expect(turns).toHaveLength(2);
    const note = turns[1].nodes[0];
    expect(note.content).not.toMatch(/failed|\[任务结果\]|｜/);
    expect(turns[1]).toMatchObject({ standalone: true, nodes: [{ id: message.id, type: 'system', content: summary }] });
    expect(message.content).toBe(content);
  });

  it('底线：裸 role:system（无 metadata）仍被总闸跳过——内部指令不外泄', () => {
    const turns = project([
      ...plainTurn(),
      {
        id: 'sys-internal',
        role: 'system',
        content: '<failed-run-continuation-context>只给模型看的内部指令</failed-run-continuation-context>',
        timestamp: 3_000,
      },
    ]);

    expect(turns.flatMap((turn) => turn.nodes).some((node) => node.id === 'sys-internal')).toBe(false);
  });

  it('只带通用标注（source）的 system 消息：不报错也不投影', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const turns = project([
        ...plainTurn(),
        {
          id: 'sys-annotation-only',
          role: 'system',
          content: '只带标注的系统消息',
          timestamp: 3_000,
          metadata: { source: 'voice' },
        } as Message,
      ]);

      expect(spy).not.toHaveBeenCalled();
      expect(turns.flatMap((turn) => turn.nodes).some((node) => node.id === 'sys-annotation-only')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('登记为内部投影的键（backgroundTaskResult）：不报错也不投影', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const turns = project([
        ...plainTurn(),
        {
          id: 'sys-internal-key',
          role: 'system',
          content: '[任务结果] 买菜｜completed｜买好了',
          timestamp: 3_000,
          metadata: {
            source: 'voice',
            backgroundTaskResult: {
              source: 'agent-result',
              taskId: 'task-1',
              shortName: '买菜',
              status: 'completed',
              summary: '买好了',
            },
          },
        } as Message,
      ]);

      expect(spy).not.toHaveBeenCalled();
      expect(turns.flatMap((turn) => turn.nodes).some((node) => node.id === 'sys-internal-key')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('带未登记 metadata 键的 system 消息：开发档 console.error 报错，且仍不投影（生产行为不变）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const turns = project([
        ...plainTurn(),
        {
          id: 'sys-unregistered',
          role: 'system',
          content: '有人新写的事件，忘了登记',
          timestamp: 3_000,
          metadata: { source: 'voice', voiceFutureEvent: { detail: 'x' } },
        } as unknown as Message,
      ]);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain('voiceFutureEvent');
      expect(turns.flatMap((turn) => turn.nodes).some((node) => node.id === 'sys-unregistered')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
