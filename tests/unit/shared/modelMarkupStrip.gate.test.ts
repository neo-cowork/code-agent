import { describe, expect, it } from 'vitest';
import { stripModelMarkup, splitThinkTags } from '../../../src/shared/modelMarkupStrip';
import { stripInternalFormatMimicry } from '../../../src/host/agent/runtime/contextAssembly/transcriptProjection';
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

// 展示出口（不含落库路径 transcriptProjection，见下方回归）：renderer filterSystemTags、后台任务结果卡、通知摘要、桌面视觉分析（共用 stripModelMarkup）
const EXITS: Array<[string, (t: string) => string]> = [
  ['shared.stripModelMarkup (desktopVisionAnalyzer)', stripModelMarkup],
  ['renderer.filterSystemTags', filterSystemTags],
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

describe('落库/转录路径不得按 think 截断正文（r1 回归）', () => {
  const body = "剥离 DeepSeek 推理标签：text.split('</think>').pop()；开标签是 <think>，示例结束。";
  it('stripInternalFormatMimicry 保留字面 </think> / <think> 的完整正文', () => {
    expect(stripInternalFormatMimicry({} as never, body)).toBe(body);
  });
  it('仍然剥 longcat 协议标记', () => {
    expect(stripInternalFormatMimicry({} as never, '好<longcat_tool_call>x')).toBe('好');
  });
});
