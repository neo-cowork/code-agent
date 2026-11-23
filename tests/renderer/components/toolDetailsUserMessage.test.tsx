import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sealBouncedToolCalls } from '../../../src/host/agent/runtime/bouncedToolCallSeal';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';
import { getToolResolver } from '../../../src/host/tools/dispatch/toolResolver';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { remindersSchema } from '../../../src/host/tools/modules/connectors/reminders.schema';
import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';
import { summarizeTool } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/summarizers';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { hydrateToolCallResults } from '../../../src/renderer/utils/messageHydration';
import { traceTerminalToolCall } from '../../../src/renderer/utils/toolCallTerminalState';
import { zh } from '../../../src/renderer/i18n/zh';
import { buildToolErrorActions } from '../../../src/renderer/utils/toolExecutionPresentation';
import type { Message, ToolCall, ToolResult } from '../../../src/shared/contract';
import { getInabilityReplyGuidance, INABILITY_REPLY_CONTRACT } from '../../../src/shared/inabilityReplyContract';

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: object) => unknown) => selector({ openPreview: vi.fn(), openSettingsTab: vi.fn() }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/host/agent/runtime/turnQuality', () => ({ attachTurnQualityMetadata: () => undefined }));

const modelInstructions = /Use MemoryRead|memory_search|ToolSearch|Follow these five reply rules|五条回复规则|The complete user-facing answer is exactly/i;

function expectCard(call: ToolCall, result: ToolResult, sentence: string) {
  const messages = hydrateToolCallResults([
    { id: 'request', role: 'user', content: '请帮我整理笔记。', timestamp: 1 },
    { id: 'call', role: 'assistant', content: '', timestamp: 2, toolCalls: [call] },
    { id: 'result', role: 'tool', content: '', timestamp: 3, toolResults: [result] },
  ]);
  const node = projectTurns(messages, 'session', false).turns[0].nodes.find((node) => node.type === 'tool_call');
  expect(node?.toolCall).toBeDefined();
  const toolCall = traceTerminalToolCall(node!.toolCall!);
  const html = renderToStaticMarkup(<ToolDetails toolCall={toolCall} />);
  expect(html).not.toMatch(modelInstructions);
  expect(html).toContain(sentence.replaceAll('>', '&gt;'));
  expect(html).not.toContain(zh.rendererHumanPipe.toolDetails.viewRawError);
  expect(buildToolErrorActions(toolCall, 'message').errorText).toBe(sentence);
  expect(summarizeTool(toolCall, zh)).not.toMatch(modelInstructions);
}

describe('tool cards show the user message produced by tool execution', () => {
  beforeAll(() => {
    const registry = getProtocolRegistry();
    if (!registry.has(remindersSchema.name)) {
      registry.register(remindersSchema, async () =>
        (await import('../../../src/host/tools/modules/connectors/reminders')).remindersModule);
    }
  });

  afterEach(() => vi.unstubAllEnvs());

  it('shows only the plain sentence for a denied read of another slot’s memory', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'neo-slot-user-message-'));
    try {
      const slot = path.join(home, '.code-agent');
      const memory = path.join(slot, 'memory');
      const workspace = path.join(home, 'workspace');
      mkdirSync(memory, { recursive: true });
      mkdirSync(workspace);
      const file = path.join(memory, 'MEMORY.md');
      writeFileSync(file, 'This fixture must stay inside the other slot.');
      vi.stubEnv('HOME', home);
      vi.stubEnv('CODE_AGENT_HOME', home);
      vi.stubEnv('CODE_AGENT_DATA_DIR', path.join(home, '.code-agent-dev'));
      vi.stubEnv('CODE_AGENT_ALLOW_CROSS_SLOT_READ', undefined);
      vi.stubEnv('CODE_AGENT_CROSS_SLOT_READ_ALLOWLIST', undefined);
      const requestPermission = vi.fn(async () => false);
      const executor = new ToolExecutor({ workingDirectory: workspace, requestPermission });
      executor.setAuditEnabled(false);
      const call = { id: 'read', name: 'Read', arguments: { file_path: file } };
      const result = await executor.execute(call.name, call.arguments, { sessionId: 'slot-user-message' });
      expect(result.metadata?.code).toBe('FOREIGN_SLOT_DATA_DIR');
      expect(result.error).toContain('Use MemoryRead or memory_search instead of reading the memory directory directly');
      expect(requestPermission).not.toHaveBeenCalled();
      expectCard(call, { toolCallId: call.id, ...result }, '这是另一个槽（.code-agent）的数据目录，当前槽无权读取');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('shows the final sentence for both the denied foreground shell and the skipped sibling', async () => {
    const calls = [
      { id: 'shell', name: 'Bash', arguments: { command: 'mkdir notes-backup' } },
      { id: 'read', name: 'Read', arguments: { file_path: 'notes.md' } },
    ];
    const prompt = '请整理当前文件夹的工作笔记。';
    const persisted: Message[] = [];
    const contextAssembly = {
      generateId: () => String(persisted.length),
      addAndPersistMessage: async (message: Message) => { persisted.push(message); },
    } as unknown as ContextAssembly;
    const ctx = {
      onEvent: vi.fn(),
      turn: { runUserPrompt: prompt, turnQuality: {} },
      turnQualityState: {},
    } as unknown as RuntimeContext;
    await sealBouncedToolCalls({ ctx, contextAssembly }, { content: '' } as ModelResponse, calls, 'denied', new Set(['shell']));
    const message = persisted.find(({ role }) => role === 'tool')!;
    const results = message.toolResults!;
    expect(results.map((result) => result.metadata?.code)).toEqual(['TOOL_DISABLED_FOR_RUN', 'TOOL_BATCH_SKIPPED']);
    for (const [index, result] of results.entries()) {
      expect(result.error).toBe(getInabilityReplyGuidance(prompt, 'zh'));
      expectCard(calls[index], result, INABILITY_REPLY_CONTRACT.zh.finalMessage);
    }
    expect(message.content).toBe(JSON.stringify(results.map(({ userMessage: _userMessage, ...rest }) => rest)));
  });

  it('shows one reconnect sentence for a Reminders read with the connector off', async () => {
    const call = { id: 'reminders', name: 'reminders', arguments: { action: 'list_reminders' } };
    const result = await getToolResolver().execute(call.name, call.arguments, {
      workingDirectory: os.tmpdir(),
      requestPermission: async () => true,
      abortSignal: new AbortController().signal,
    });
    expect(result.metadata?.code).toBe('NOT_INITIALIZED');
    expect(result.error).toContain('The complete user-facing answer is exactly this single everyday sentence:');
    expectCard(call, { toolCallId: call.id, ...result }, '提醒事项还没有连接，所以这次看不到你的提醒事项，请在能力中心 > 连接器打开后再试。');
  });
});
