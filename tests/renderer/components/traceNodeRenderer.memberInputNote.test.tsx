// @vitest-environment jsdom
// N-SUBAGENT-INPUT：主对话里的折叠记录渲染成一行「你给 {name} 补了一句：…」，不走助手气泡。
// N-FIX-EN-MEMBER-NOTE-FULLWIDTH-COLON：分隔符收进词条（zh 全角冒号 / en 半角冒号+空格），
// en 渲染结果不得出现 U+FF1A；language 必须透传给 useI18n（localizeStoredMemberName 依赖它）。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({ t: i18nState.language === 'en' ? en : zh, language: i18nState.language }),
  };
});
vi.mock('../../../src/renderer/components/features/chat/MessageBubble/MessageContent', () => ({
  MessageContent: ({ content }: { content: string }) => content,
}));
vi.mock('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/index', () => ({ ToolCallDisplay: () => null }));
vi.mock('../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview', () => ({ AttachmentDisplay: () => null }));
vi.mock('../../../src/renderer/components/features/chat/ExpandableContent', () => ({ ExpandableContent: () => null }));

import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

const FULLWIDTH_COLON = '：';

/** 折叠记录那一行的渲染文本（data-testid="member-input-note" 的 <p> 内文）。 */
function noteText(html: string): string {
  const match = html.match(/<p[^>]*data-testid="member-input-note"[^>]*>([\s\S]*?)<\/p>/);
  expect(match, 'member-input-note element should render').toBeTruthy();
  return match![1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

describe('TraceNodeRenderer · member input note', () => {
  it.each([
    ['supplement', '你给 溯真 补了一句：顺便把页码加上', 'You added a note for Suzhen: Please also add page numbers'],
    ['redirect', '你让 溯真 改道：顺便把页码加上', 'You redirected Suzhen: Please also add page numbers'],
  ] as const)('renders the %s record in zh and en, each with its own separator', (mode, zhLine, enLine) => {
    const makeNode = (content: string): TraceNode => ({
      id: 'steer-1-member-input', messageId: 'steer-1', type: 'assistant_text', content, timestamp: 110,
      metadata: { memberInput: { memberId: 'task-7', memberName: '溯真', mode } },
    });

    // en 用户：笔记内容是英文（真实 en 界面用户会说英文），内置成员名本地化成 Suzhen，
    // 分隔符是半角冒号+空格，整行不得出现 U+FF1A。（en 在前：反变异时这里是第一道红。）
    i18nState.language = 'en';
    const enHtml = renderToStaticMarkup(React.createElement(TraceNodeRenderer, { node: makeNode('Please also add page numbers') }));
    expect(enHtml).toContain('data-testid="member-input-note"');
    expect(noteText(enHtml)).toBe(enLine);
    expect(noteText(enHtml)).not.toContain(FULLWIDTH_COLON);
    expect(noteText(enHtml)).not.toContain('溯真');

    // zh 用户：笔记内容是中文，名字保持原样，分隔符是全角冒号。
    i18nState.language = 'zh';
    const zhHtml = renderToStaticMarkup(React.createElement(TraceNodeRenderer, { node: makeNode('顺便把页码加上') }));
    expect(zhHtml).toContain('data-testid="member-input-note"');
    expect(noteText(zhHtml)).toBe(zhLine);
    expect(noteText(zhHtml)).toContain(FULLWIDTH_COLON);
    expect(noteText(zhHtml)).not.toContain('Suzhen');
  });
});
