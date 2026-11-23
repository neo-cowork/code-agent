// ADR-068 刀 4：断流续接的词表消费 —— host 落库的 [连接中断]/[生成中断] 正文标记（刀 3）
// 进 StreamInterruptionReason 稳定枚举；重载视图剥裸协议标记、断点段正文保留（不 suppression），
// 用户停止前的可见正文也保留；DecisionSlot 文案按词表派生。
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { buildStreamRecoveryMessage } from '../../../src/renderer/utils/streamRecoveryMessage';
import { resolveStreamInterruptionOutcomeKey, outcomeWordsZh } from '../../../src/renderer/i18n/outcomeWords';
import {
  deriveStreamInterruptionReason,
  streamInterruptionReasonFromContent,
  stripStreamBreakMarker,
} from '../../../src/renderer/utils/streamInterruptionPresentation';

const USER: Message = { id: 'u1', role: 'user', content: '写一段', timestamp: 1_000 };
const STOPPED_PARTIAL: Message = {
  id: 'a1',
  role: 'assistant',
  content: 'partial text\n\n[cancelled]',
  timestamp: 2_000,
};

const BREAK_PARTIAL: Message = {
  id: 'a1',
  role: 'assistant',
  content: 'PART1__断点片段。\n\n[连接中断 — 部分回答已保留]',
  timestamp: 2_000,
};

const ERROR_PARTIAL: Message = {
  id: 'a1e',
  role: 'assistant',
  content: '会沉没的片段。\n\n[生成中断 — 部分回答已保留]',
  timestamp: 2_000,
};

describe('断流标记 → StreamInterruptionReason 词表（ADR-068 刀 3 落库 / 刀 4 消费）', () => {
  it('两个断流标记都识别为 stream-break；既有 cancelled/session-switch 词表零漂移', () => {
    expect(streamInterruptionReasonFromContent(BREAK_PARTIAL.content)).toBe('stream-break');
    expect(streamInterruptionReasonFromContent(ERROR_PARTIAL.content)).toBe('stream-break');
    // 破折号全角/半角与空白都容错（对齐 SESSION_SWITCH_MARKER 的既有口径）
    expect(streamInterruptionReasonFromContent('片段\n\n[连接中断-部分回答已保留]')).toBe('stream-break');
    expect(streamInterruptionReasonFromContent('被打停止\n\n[cancelled]')).toBe('user');
    expect(streamInterruptionReasonFromContent('中断\n\n[未完成 — 切换会话中断]')).toBe('session-switch');
    expect(streamInterruptionReasonFromContent('正常回答')).toBeNull();
  });

  it('stripStreamBreakMarker：剥掉尾部标记与前导空白；无标记原样返回', () => {
    expect(stripStreamBreakMarker(BREAK_PARTIAL.content)).toBe('PART1__断点片段。');
    expect(stripStreamBreakMarker('片段\n\n[生成中断 — 部分回答已保留]\n')).toBe('片段');
    expect(stripStreamBreakMarker('正文中间[连接中断 — 部分回答已保留]不算尾部')).toBe(
      '正文中间[连接中断 — 部分回答已保留]不算尾部',
    );
    expect(stripStreamBreakMarker('普通正文')).toBe('普通正文');
  });

  it('耗尽态 DecisionSlot 的中断原因由落库标记派生：backward 扫描命中 stream-break', () => {
    expect(deriveStreamInterruptionReason([
      { id: 'u1', role: 'user', content: '写一段', timestamp: 1_000 },
      BREAK_PARTIAL,
    ])).toBe('stream-break');
    // 既有默认/取消路径零漂移
    expect(deriveStreamInterruptionReason([
      { id: 'u1', role: 'user', content: '写一段', timestamp: 1_000 },
      { id: 'a1', role: 'assistant', content: '被打停止\n\n[cancelled]', timestamp: 2_000 },
    ])).toBe('user');
  });

  it('词表闭环：stream-break → interrupted-stream-break，四个受众文案非空', () => {
    expect(resolveStreamInterruptionOutcomeKey('stream-break')).toBe('interrupted-stream-break');
    const copy = outcomeWordsZh.outcomeWords['interrupted-stream-break'];
    for (const audience of ['timeline', 'badge', 'detail', 'notification'] as const) {
      expect(copy[audience].label.trim()).not.toBe('');
      expect(copy[audience].reason.trim()).not.toBe('');
    }
  });
});

describe('重载视图投影：断点段保留 + 裸标记不上屏（ADR-068 刀 4）', () => {
  it('stream-break 断点段：正文保留（剥标记）+ metadata 带稳定枚举——真实答案的前半段不许消失', () => {
    const projection = projectTurns([
      { id: 'u1', role: 'user', content: '写一段', timestamp: 1_000 },
      BREAK_PARTIAL,
      { id: 'a2', role: 'assistant', content: 'PART2__续答正文。', timestamp: 3_000 },
    ], 'session-1', false);

    const textNodes = projection.turns.flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'assistant_text');
    expect(textNodes).toHaveLength(2);
    // 断点段：内容剥掉裸协议标记，中断语义进 metadata（样式行按枚举渲染）
    expect(textNodes[0].content).toBe('PART1__断点片段。');
    expect(textNodes[0].metadata?.streamInterruptionReason).toBe('stream-break');
    expect(textNodes[0].content).not.toContain('[');
    // 续答段不受影响
    expect(textNodes[1].content).toBe('PART2__续答正文。');
  });

  it.each(['live draft', 'persisted reload'])('keeps the partial reply after Stop (%s)', (shape) => {
    const assistant = shape === 'live draft' ? {
      ...STOPPED_PARTIAL,
      id: 'turn-1',
      toolCalls: [],
      metadata: { correlation: { turnId: 'turn-1' } },
    } : STOPPED_PARTIAL;
    const projection = projectTurns([USER, assistant], 'session-1', false);

    const textNodes = projection.turns.flatMap((turn) => turn.nodes)
      .filter((node) => node.type === 'assistant_text');
    expect(textNodes.map((node) => node.content)).toEqual(['partial text']);
  });

  const recovery = buildStreamRecoveryMessage({
    sessionId: 'session-1',
    turnId: 'recovery-turn',
    content: 'partial text',
    reasoning: '',
    toolCalls: [{ id: 'write-1', name: 'Write', arguments: '{"file_path":"draft.md"}' }],
    estimatedTokens: 2,
    timestamp: 3_000,
    isFinal: false,
    streamStatus: 'incomplete',
    stableForExecution: false,
    incompleteToolCallIds: [],
  }, 'user');

  it('defers to a recovery snapshot in the same turn', () => {
    const persisted: Message = {
      ...STOPPED_PARTIAL,
      metadata: { correlation: { turnId: 'recovery-turn' } },
    };
    const { turns } = projectTurns([USER, persisted, recovery], 'session-1', false);
    const nodes = turns.flatMap((turn) => turn.nodes);
    expect(nodes.filter((node) => node.type === 'assistant_text')).toHaveLength(0);
    const toolNodes = nodes.filter((node) => node.type === 'tool_call');
    expect(toolNodes).toHaveLength(1);
    expect(toolNodes[0].metadata?.streamRecovery?.turnId).toBe('recovery-turn');
  });

  it('keeps the persisted partial over its text-only snapshot on reload', () => {
    const textOnlyRecovery: Message = { ...recovery, content: 'partial', toolCalls: [] };
    const persisted: Message = {
      ...STOPPED_PARTIAL,
      metadata: { correlation: { turnId: 'recovery-turn' } },
    };
    const { turns } = projectTurns([USER, persisted, textOnlyRecovery], 'session-1', false);
    const nodes = turns.flatMap((turn) => turn.nodes);
    expect(nodes.filter((node) => node.type === 'assistant_text').map((node) => node.content))
      .toEqual(['partial text']);
  });

  it('keeps the partial when recovery belongs to another turn', () => {
    const nextUser: Message = { ...USER, id: 'u2', timestamp: 2_500 };
    const { turns } = projectTurns([USER, STOPPED_PARTIAL, nextUser, recovery], 'session-1', false);
    const nodes = turns.flatMap((turn) => turn.nodes);
    expect(nodes.filter((node) => node.type === 'assistant_text').map((node) => node.content))
      .toEqual(['partial text']);
  });
});
