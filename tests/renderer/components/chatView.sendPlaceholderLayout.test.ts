// N-FIX-TURN-DURATION-ZERO-AND-SENDING-OVERLAP：「正在发送消息…」曾用 absolute 叠在消息区底部，
// 压住最后一张卡片的「日历 · 查询日程未成功」那行。占位行必须在消息区之外、占自己的高度。
// 渲染整个 ChatView 要拉起几十个 store，这里按源码结构断言；视觉证据见证据档 headless 截图。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/components/ChatView.tsx'), 'utf8');

describe('发送中占位行不与消息区重叠', () => {
  it('占位行不是绝对定位，且排在消息滚动区闭合之后', () => {
    const placeholderAt = source.indexOf('data-testid="assistant-send-placeholder"');
    expect(placeholderAt).toBeGreaterThan(-1);
    const openTag = source.slice(source.lastIndexOf('<div', placeholderAt), source.indexOf('>', placeholderAt) + 1);
    expect(openTag).not.toMatch(/\babsolute\b/);

    const messagesAreaAt = source.indexOf('<div className="relative flex-1 min-h-0 overflow-hidden');
    expect(messagesAreaAt).toBeGreaterThan(-1);
    const footerAt = source.indexOf('<div className="shrink-0">', messagesAreaAt);
    expect(footerAt).toBeGreaterThan(messagesAreaAt);
    expect(placeholderAt).toBeGreaterThan(footerAt);
  });

  it('每次点发送都把发送时刻交给消息列表，列表据此立刻落底（N-FIX-CHAT-BOTTOM-CARD-HIDDEN-UNDER-COMPOSER）', () => {
    const viewAt = source.indexOf('<TurnBasedTraceView');
    expect(viewAt).toBeGreaterThan(-1);
    const viewTag = source.slice(viewAt, source.indexOf('/>', viewAt));
    expect(viewTag).toMatch(/userSendAt=\{pendingAssistantFeedback\?\.startedAt \?\? null\}/);
  });
});
