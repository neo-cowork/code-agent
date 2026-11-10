// @vitest-environment jsdom
// 后台代理续跑提示只挂在会话里最后一张失败卡上；代理结束后所有卡的提示都消失（不重挂载）。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentErrorCategory, Message } from '../../../src/shared/contract';

const runtime = vi.hoisted(() => ({ invokeDomain: vi.fn() }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain: runtime.invokeDomain } }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

afterEach(() => { cleanup(); vi.useRealTimers(); runtime.invokeDomain.mockReset(); });

let seq = 0;
const user = (): Message => { seq += 1; return { id: `user-${seq}`, role: 'user', content: '做一份演示稿', timestamp: seq * 100 }; };
const fail = (category: AgentErrorCategory, withTool = false): Message => {
  seq += 1;
  return { id: `assistant-${seq}`, role: 'assistant', content: '', timestamp: seq * 100,
    ...(withTool ? { toolCalls: [{ id: `tc-${seq}`, name: 'spawn_agent', arguments: {} }] } : {}),
    metadata: { agentError: { category, rawMessage: 'provider error', timestamp: seq * 100 } } };
};

it('two failure cards + one live background child: one notice on the last card, zero after the child ends', async () => {
  vi.useFakeTimers();
  let terminal = false;
  runtime.invokeDomain.mockImplementation(async () => ({ sessionId: 'session-1', nodes: [{ background: true, status: terminal ? 'completed' : 'running' }] }));
  const failing = fail('network', true);
  // the same failed message projected twice (duplicated client message list) must still yield a single notice
  const nodes = projectTurns([user(), fail('auth'), user(), failing, failing], 'session-1', false)
    .turns.flatMap((turn) => turn.nodes).filter((n) => n.metadata?.agentError);
  // the failing message that spawned the child also projects a tool-call node carrying the same agentError metadata
  expect(nodes.length).toBeGreaterThanOrEqual(3);
  const view = render(<>{nodes.map((node, index) => (
    <div key={index} data-testid={`card-${index}`}>
      <TraceNodeRenderer node={node} sessionId="session-1" />
    </div>
  ))}</>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const notices = view.queryAllByTestId('background-children-notice');
  expect(notices).toHaveLength(1);
  expect(view.getByTestId(`card-${nodes.map((n) => n.type).lastIndexOf('assistant_text')}`).contains(notices[0])).toBe(true);
  terminal = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(view.queryAllByTestId('background-children-notice')).toHaveLength(0);
});
