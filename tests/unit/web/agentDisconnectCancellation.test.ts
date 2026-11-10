import express from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { Message } from '../../../src/shared/contract';
import { createRunContext, createRunHandle, type RunCancelReason } from '../../../src/host/runtime/runContext';
import { ConversationRuntime } from '../../../src/host/agent/runtime/conversationRuntime';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { saveStreamSnapshot, loadStreamSnapshot } from '../../../src/host/session/streamSnapshot';
import { AgentRunController } from '../../../src/web/routes/agentRunController';
import { setDaemonQuitIntent } from '../../../src/host/services/daemon/quitIntent';
import { registerAgentCancelRoute } from '../../../src/web/routes/registerAgentCancelRoute';
import type { RunRegistry } from '../../../src/host/runtime/runRegistry';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function setup(text = 'Weekly summary so far') {
  const workspace = mkdtempSync(path.join(tmpdir(), 'neo-disconnect-'));
  dirs.push(workspace);
  const context = createRunContext({ sessionId: 'session-1', runId: 'run-1', workspace });
  const handle = createRunHandle(context);
  const control = new ControlState();
  const messages: Message[] = [];
  const file = path.join(workspace, 'messages.json');
  const runtime = new ConversationRuntime({
    workingDirectory: workspace, sessionId: context.sessionId, control, messages,
    turn: TurnState.forTest({ lastStreamedContent: text }),
    persistMessage: async () => { writeFileSync(file, JSON.stringify(messages)); },
  } as unknown as RuntimeContext);
  const cancel = vi.fn((reason?: RunCancelReason) => runtime.cancel(reason));
  await handle.attach({ cancel });
  saveStreamSnapshot({ content: text, reasoning: '', toolCalls: [], estimatedTokens: 1, timestamp: Date.now(), isFinal: false }, {
    workingDir: workspace, sessionId: context.sessionId, runId: context.runId, turnId: 'turn-1',
  });
  setDaemonQuitIntent('stop');
  const controller = new AgentRunController({
    res: { destroyed: true, writableEnded: false } as Response,
    runId: context.runId, sessionId: context.sessionId, runHandle: handle,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tryGetSessionManager: async () => null,
  });
  return { handle, control, cancel, controller,
    persisted: () => JSON.parse(readFileSync(file, 'utf8')) as Message[],
    snapshot: () => loadStreamSnapshot({ workingDir: workspace, sessionId: context.sessionId }),
  };
}

describe('SSE disconnect cancellation through the production controller and real run handle/runtime', () => {
  it.each(['Weekly summary so far', ''])('persists a connection break, including tool-only streams (%j)', async (text) => {
    const state = await setup(text);
    state.controller.cancelForDisconnect();
    await vi.waitFor(() => expect(state.control.isCancelled).toBe(true));
    await state.cancel.mock.results[0].value;
    expect(state.cancel).toHaveBeenCalledExactlyOnceWith('client-disconnect');
    expect(state.control.cancelReason).toBe('client-disconnect');
    expect(state.snapshot()?.interruptionReason).toBe('stream-break');
    expect(state.snapshot()?.interruptionReason).not.toBe('user');
    expect(state.persisted()[0]).toMatchObject({
      metadata: { streamInterruptionReason: 'stream-break', workbench: { runCancellation: { reason: 'client_disconnect' } } },
    });
    expect(state.persisted()[0].content).not.toContain('[cancelled]');
    state.controller.destroy();
  });

  it('POST /api/cancel still delivers user and persists the user stop marker', async () => {
    const state = await setup();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerAgentCancelRoute(router, { resolve: () => state.handle, get: () => undefined } as unknown as RunRegistry);
    app.use('/api', router);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'run-1' }),
      });
      expect(res.status).toBe(200);
      expect(state.cancel).toHaveBeenCalledExactlyOnceWith('user');
      expect(state.control.cancelReason).toBe('user');
      expect(state.snapshot()?.interruptionReason).toBe('user');
      expect(state.persisted()[0].content).toContain('[cancelled]');
      expect(state.persisted()[0].content).not.toContain('连接中断');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      state.controller.destroy();
    }
  });
});
