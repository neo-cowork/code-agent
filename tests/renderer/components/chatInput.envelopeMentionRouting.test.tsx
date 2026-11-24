// @vitest-environment jsdom
//
// N-MENTION-CJK-ROLE-FIX hook 级回放：用户真实提交路径
// （ChatInput → useChatInputEnvelope → parseLeadingAgentMentions）下，
// 中文角色名 @ mention 必须产出 direct 路由；解析失败则不带 routing、原文照发。

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChatInputEnvelope } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputEnvelope';

function buildParams() {
  return {
    swarmAgents: [{ id: 'designer', name: '设计师' }],
    agentEntries: [{ id: 'designer', name: '设计师' }],
    activeAgentId: null,
    browserSession: { sessionActive: false } as never,
    voiceInputContext: null,
    buildContext: () => undefined,
    pendingPromptCommand: null,
    pendingAgentSelection: null,
  };
}

describe('useChatInputEnvelope · 中文角色 @ mention 直连路由', () => {
  it('"@设计师 改一下配色" 产出 routing.direct 指向 designer，content 去掉 mention 前缀', () => {
    const { result } = renderHook(() => useChatInputEnvelope(buildParams() as never));
    const envelope = result.current('@设计师 改一下配色');
    expect(envelope.content).toBe('改一下配色');
    expect(envelope.context?.routing).toEqual({
      mode: 'direct',
      targetAgentIds: ['designer'],
    });
  });

  it('未知中文 mention "@不存在 你好" 不带 routing，content 为完整原文', () => {
    const { result } = renderHook(() => useChatInputEnvelope(buildParams() as never));
    const envelope = result.current('@不存在 你好');
    expect(envelope.context?.routing).toBeUndefined();
    expect(envelope.content).toBe('@不存在 你好');
  });
});
