import { describe, expect, it } from 'vitest';
import { stripModelMarkup, splitThinkTags } from '../../../src/shared/modelMarkupStrip';
import { stripToolCallProtocolMarkup } from '../../../src/host/agent/runtime/contextAssembly/transcriptProjection';
import { buildSessionTaskResultMessage } from '../../../src/host/services/commandCenter/sessionCommandTaskRestartRecovery';
import { sanitizeNotificationText } from '../../../src/host/services/infra/notificationPolicy';
import { filterSystemTags } from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';

const LEAKS = [
  '推理原文</think>最终答案',
  '<think>推理</think>最终答案',
  '最终答案<think>没写完',
  '最终答案<longcat_tool_call><longcat_arg_key>a</longcat_arg_key>',
  '推理原文</think>最终答案</longcat_tool_call>',
];
const FORBIDDEN = /<\/?think>|longcat_|推理原文|没写完/;

// 用户可见出口：renderer filterSystemTags、转录投影、后台任务结果卡、通知摘要、桌面视觉分析（共用 stripModelMarkup）
const EXITS: Array<[string, (t: string) => string]> = [
  ['shared.stripModelMarkup (desktopVisionAnalyzer)', stripModelMarkup],
  ['renderer.filterSystemTags', filterSystemTags],
  ['transcriptProjection.stripToolCallProtocolMarkup', stripToolCallProtocolMarkup],
  ['notification sanitizeNotificationText', (t) => sanitizeNotificationText(t, 400)],
  ['task result card', (t) => JSON.stringify(buildSessionTaskResultMessage({ id: 't1', shortName: 'x' }, 'completed' as never, t))],
];

describe('用户可见出口不泄漏 think / longcat 字面量', () => {
  for (const [name, fn] of EXITS) {
    for (const leak of LEAKS) {
      it(`${name}: ${leak.slice(0, 24)}`, () => {
        expect(fn(leak)).not.toMatch(FORBIDDEN);
      });
    }
  }
  it('孤儿闭标签保留标签后的正文', () => {
    expect(stripModelMarkup('推理原文</think>最终答案')).toBe('最终答案');
    expect(splitThinkTags('r</think>a', '')).toEqual({ content: 'a', reasoning: 'r' });
  });
});
