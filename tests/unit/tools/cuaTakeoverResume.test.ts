import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getToolExecutionTimeoutMs } from '../../../src/shared/constants/timeouts';
import type { AgentEvent } from '../../../src/shared/contract';
import type { CanUseToolFn, ToolContext } from '../../../src/host/protocol/tools';
import { createToolExecutionWatchdog } from '../../../src/host/agent/runtime/toolExecutionTimeout';
import {
  CuaStateAdapter,
  type CuaDriverCallContext,
  type CuaDriverCallResult,
  type CuaDriverPort,
} from '../../../src/host/mcp/cuaStateAdapter';
import { CuaStatefulComputerUseHandler } from '../../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import {
  createHumanWaitBoundTimeout,
  getHumanWaitMs,
  isHumanWaitActive,
} from '../../../src/host/services/infra/timeoutController';
import { SurfaceExecutionRuntime } from '../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { clearApprovalWait, getApprovalWaitMs } from '../../../src/host/tools/toolExecutionTelemetry';

const EXPECTED_SCREEN_TOUCHED_NOTE =
  'A human used this screen since your last look, so it may have changed. Observe again before acting.';

class TakeoverFakeCuaDriver implements CuaDriverPort {
  readonly calls: Array<{ toolName: string; context: CuaDriverCallContext }> = [];
  private observation = 0;

  async call(
    toolName: string,
    _args: Record<string, unknown>,
    context: CuaDriverCallContext,
  ): Promise<CuaDriverCallResult> {
    this.calls.push({ toolName, context });
    if (toolName === 'list_windows') {
      return {
        success: true,
        structured: {
          windows: [{
            pid: 42,
            window_id: 7,
            app_name: 'Notes',
            title: 'Weekly report',
            is_on_screen: true,
            on_current_space: true,
          }],
        },
      };
    }
    if (toolName === 'get_window_state') {
      this.observation += 1;
      return {
        success: true,
        structured: {
          snapshot_id: `snapshot-${this.observation}`,
          screenshot_width: 200,
          screenshot_height: 100,
          elements: [{
            element_index: 1,
            element_token: `token-${this.observation}`,
            role: 'AXButton',
            label: this.observation > 1 ? 'Continue after login' : 'Sign in',
            frame: { x: 10, y: 10, w: 80, h: 20 },
          }],
        },
        screenshot: {
          data: Buffer.from(`screen-${this.observation}`).toString('base64'),
          mimeType: 'image/png',
        },
      };
    }
    return { success: true, output: 'ok' };
  }

  getGeneration(): string | undefined {
    return 'cua-driver:takeover-test-gen';
  }
}

function makeToolContext(input: {
  conversationId?: string;
  runId?: string;
  agentId?: string;
  toolCallId: string;
  abortSignal?: AbortSignal;
  events?: AgentEvent[];
}): ToolContext {
  return {
    runId: input.runId ?? 'run-cua-1',
    sessionId: input.conversationId ?? 'conversation-cua-1',
    workspace: process.cwd(),
    workingDir: process.cwd(),
    abortSignal: input.abortSignal ?? new AbortController().signal,
    agentId: input.agentId ?? 'agent-cua-a',
    currentToolCallId: input.toolCallId,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    emit(event) {
      input.events?.push(event);
    },
  };
}

function createHarness(conversationId = 'conversation-cua-1', runId = 'run-cua-1') {
  const registry = new RunRegistry();
  registry.start({ runId, sessionId: conversationId, workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const driver = new TakeoverFakeCuaDriver();
  const adapter = new CuaStateAdapter(driver);
  const executeSpy = vi.spyOn(adapter, 'execute');
  const handler = new CuaStatefulComputerUseHandler(adapter, runtime);
  const permit: CanUseToolFn = async () => ({ allow: true });
  return { registry, runtime, driver, adapter, executeSpy, handler, permit, conversationId, runId };
}

async function seedObservedComputerSession(h: ReturnType<typeof createHarness>) {
  const observed = await h.handler.execute(
    { operation: 'observe', targetApp: 'Notes', target: { pid: 42, windowId: 7 } },
    makeToolContext({ conversationId: h.conversationId, runId: h.runId, toolCallId: 'observe-init' }),
    h.permit,
  );
  expect(observed.ok).toBe(true);
  if (!observed.ok) throw new Error(observed.error);
  const stateId = (JSON.parse(observed.output) as { state: { stateId: string } }).state.stateId;
  const surfaceSessionId = (observed.meta as { surfaceSessionId: string }).surfaceSessionId;
  const subject = { sessionId: surfaceSessionId, runId: h.runId, agentId: 'agent-cua-a' };
  h.executeSpy.mockClear();
  const driverCallsBaseline = h.driver.calls.length;
  return { stateId, surfaceSessionId, subject, driverCallsBaseline };
}

describe('N-CUA-TAKEOVER-RESUME computer-use human takeover & resume', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    clearApprovalWait('act-wait-1');
    clearApprovalWait('obs-wait-1');
    clearApprovalWait('tc-budget-150s');
    vi.useRealTimers();
  });

  it('① & ② holds act during waiting_human with 0 adapter execute calls, then on release returns human-touched note + SURFACE_STATE_STALE until fresh observe', async () => {
    const h = createHarness('conv-1', 'run-1');
    const { stateId, subject, driverCallsBaseline } = await seedObservedComputerSession(h);

    await h.runtime.control(subject, 'takeover');
    expect(h.runtime.sessions.requireOwned(subject.sessionId, subject).state).toBe('waiting_human');

    let settled = false;
    const pendingAct = h.handler.execute(
      {
        operation: 'act',
        targetApp: 'Notes',
        stateId,
        mutation: { kind: 'click', elementRef: 'e1' },
      },
      makeToolContext({ conversationId: h.conversationId, runId: h.runId, toolCallId: 'act-wait-1' }),
      h.permit,
    ).then((res) => {
      settled = true;
      return res;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    // ① While waiting_human: NO input sent and operation waits for release instead of failing or dispatching
    expect(h.executeSpy).toHaveBeenCalledTimes(0);
    expect(h.driver.calls).toHaveLength(driverCallsBaseline);
    expect(settled).toBe(false);

    // User finishes on screen and presses Done (resume)
    await h.runtime.control(subject, 'resume');
    await vi.advanceTimersByTimeAsync(150);
    const releasedAct = await pendingAct;

    // ① & ② Still 0 adapter execute calls on stale pre-takeover state; rejected with SURFACE_STATE_STALE + human-touched note
    expect(h.executeSpy).toHaveBeenCalledTimes(0);
    expect(h.driver.calls).toHaveLength(driverCallsBaseline);
    expect(releasedAct.ok).toBe(false);
    if (releasedAct.ok) throw new Error('expected SURFACE_STATE_STALE');
    expect(releasedAct.code).toBe('SURFACE_STATE_STALE');
    expect(releasedAct.error.startsWith(`${EXPECTED_SCREEN_TOUCHED_NOTE}\n\n`)).toBe(true);
    console.info(`[cua-takeover-②] releasedAct code=${releasedAct.code} error=${JSON.stringify(releasedAct.error)}`);

    // Retrying old state again is still rejected as stale, without repeating the already-consumed note
    const retryStale = await h.handler.execute(
      {
        operation: 'act',
        targetApp: 'Notes',
        stateId,
        mutation: { kind: 'click', elementRef: 'e1' },
      },
      makeToolContext({ conversationId: h.conversationId, runId: h.runId, toolCallId: 'act-stale-retry' }),
      h.permit,
    );
    expect(retryStale).toMatchObject({ ok: false, code: 'SURFACE_STATE_STALE' });
    if (!retryStale.ok) {
      expect(retryStale.error).not.toContain(EXPECTED_SCREEN_TOUCHED_NOTE);
    }
    expect(h.executeSpy).toHaveBeenCalledTimes(0);

    // Fresh observe succeeds and subsequent act on fresh state dispatches cleanly
    const reobserved = await h.handler.execute(
      { operation: 'observe', targetApp: 'Notes', target: { pid: 42, windowId: 7 } },
      makeToolContext({ conversationId: h.conversationId, runId: h.runId, toolCallId: 'observe-after-release' }),
      h.permit,
    );
    expect(reobserved.ok).toBe(true);
    if (!reobserved.ok) throw new Error(reobserved.error);
    expect(reobserved.output).not.toContain(EXPECTED_SCREEN_TOUCHED_NOTE);
    const freshStateId = (JSON.parse(reobserved.output) as { state: { stateId: string } }).state.stateId;

    const freshAct = await h.handler.execute(
      {
        operation: 'act',
        targetApp: 'Notes',
        stateId: freshStateId,
        mutation: { kind: 'click', elementRef: 'e1' },
      },
      makeToolContext({ conversationId: h.conversationId, runId: h.runId, toolCallId: 'act-fresh' }),
      h.permit,
    );
    expect(freshAct.ok).toBe(true);
    expect(h.driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(1);
  });

  it('①b & ②b holds observe during waiting_human with 0 adapter execute calls, then prepends note once on release while old stateId remains SURFACE_STATE_STALE', async () => {
    const h = createHarness('conv-2', 'run-2');
    const { stateId: oldStateId, subject, driverCallsBaseline } = await seedObservedComputerSession(h);

    await h.runtime.control(subject, 'takeover');
    let settled = false;
    const pendingObserve = h.handler.execute(
      { operation: 'observe', targetApp: 'Notes', target: { pid: 42, windowId: 7 } },
      makeToolContext({ conversationId: h.conversationId, runId: h.runId, toolCallId: 'obs-wait-1' }),
      h.permit,
    ).then((res) => {
      settled = true;
      return res;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(h.executeSpy).toHaveBeenCalledTimes(0);
    expect(h.driver.calls).toHaveLength(driverCallsBaseline);
    expect(settled).toBe(false);

    await h.runtime.control(subject, 'resume');
    await vi.advanceTimersByTimeAsync(150);
    const observedAfter = await pendingObserve;
    expect(observedAfter.ok).toBe(true);
    if (!observedAfter.ok) throw new Error(observedAfter.error);
    expect(observedAfter.output.startsWith(`${EXPECTED_SCREEN_TOUCHED_NOTE}\n\n`)).toBe(true);

    // Old pre-takeover stateId is still rejected with SURFACE_STATE_STALE
    const staleAct = await h.handler.execute(
      {
        operation: 'act',
        targetApp: 'Notes',
        stateId: oldStateId,
        mutation: { kind: 'click', elementRef: 'e1' },
      },
      makeToolContext({ conversationId: h.conversationId, runId: h.runId, toolCallId: 'act-old-after-obs' }),
      h.permit,
    );
    expect(staleAct).toMatchObject({ ok: false, code: 'SURFACE_STATE_STALE' });
    console.info(
      `[cua-takeover-②b] observedAfter.head=${JSON.stringify(observedAfter.output.slice(0, 120))} staleAct.code=${!staleAct.ok ? staleAct.code : 'ok'}`,
    );
  });

  it('③ subtracts a wait longer than the 120s no-progress limit via getApprovalWaitMs and pauses run human-wait clock', async () => {
    const h = createHarness('conv-budget', 'run-budget');
    const { stateId, subject } = await seedObservedComputerSession(h);
    await h.runtime.control(subject, 'takeover');

    const noProgressLimitMs = getToolExecutionTimeoutMs('computer_use');
    expect(noProgressLimitMs).toBe(120_000);

    const toolCallId = 'tc-budget-150s';
    const watchdogEvents: AgentEvent[] = [];
    const onTimeoutWarn = vi.fn();
    const aborted = vi.fn();
    const startedAt = Date.now();
    const watchdog = createToolExecutionWatchdog({
      toolCallId,
      toolName: 'computer_use',
      startedAt,
      onEvent: (event) => watchdogEvents.push(event),
      onTimeoutWarn,
    });
    const runBudget = createHumanWaitBoundTimeout(180_000, 'run budget exceeded', h.conversationId);
    watchdog.startProgressReporter();

    try {
      const watched = watchdog.awaitExecution(
        h.handler.execute(
          {
            operation: 'act',
            targetApp: 'Notes',
            stateId,
            mutation: { kind: 'click', elementRef: 'e1' },
          },
          makeToolContext({ conversationId: h.conversationId, runId: h.runId, toolCallId }),
          h.permit,
        ),
        aborted,
      );

      // Advance 150,000 ms (> 120,000 ms no-progress limit) using injected fake clock
      await vi.advanceTimersByTimeAsync(150_000);

      const approvalWaitDuring = getApprovalWaitMs(toolCallId, Date.now());
      const humanWaitDuring = getHumanWaitMs(h.conversationId, Date.now());
      const runElapsedDuring = runBudget.controller.getElapsedMs(Date.now());
      const lastProgress = watchdogEvents
        .filter((event) => event.type === 'tool_progress')
        .at(-1) as { type: 'tool_progress'; data: { elapsedMs: number; inactiveMs: number } } | undefined;

      expect(approvalWaitDuring).toBe(150_000);
      expect(humanWaitDuring).toBe(150_000);
      expect(runElapsedDuring).toBe(0);
      expect(lastProgress?.data).toEqual(expect.objectContaining({ elapsedMs: 0, inactiveMs: 0 }));
      expect(watchdogEvents.filter((event) => event.type === 'tool_timeout')).toEqual([]);
      expect(onTimeoutWarn).not.toHaveBeenCalled();
      expect(aborted).not.toHaveBeenCalled();
      expect(h.executeSpy).toHaveBeenCalledTimes(0);

      await h.runtime.control(subject, 'resume');
      await vi.advanceTimersByTimeAsync(100);
      const settled = await watched;

      const approvalWaitTotal = getApprovalWaitMs(toolCallId, Date.now());
      console.info(
        `[cua-takeover-③] noProgressLimitMs=${noProgressLimitMs} approvalWaitDuring=${approvalWaitDuring} humanWaitDuring=${humanWaitDuring} runElapsedDuring=${runElapsedDuring} watchdogElapsedMs=${lastProgress?.data.elapsedMs} watchdogInactiveMs=${lastProgress?.data.inactiveMs} approvalWaitTotal=${approvalWaitTotal}`,
      );
      expect(approvalWaitTotal).toBe(150_100);
      expect(isHumanWaitActive(h.conversationId)).toBe(false);
      expect(settled).toMatchObject({ ok: false, code: 'SURFACE_STATE_STALE' });
      expect(watchdogEvents.filter((event) => event.type === 'tool_timeout')).toEqual([]);
      expect(aborted).not.toHaveBeenCalled();
    } finally {
      watchdog.stop();
      runBudget.unbind();
      runBudget.controller.clear();
    }
  });

  it('⑤ releases the wait without hanging on stop, end_session, and abortSignal', async () => {
    // 1. stop during wait
    const hStop = createHarness('conv-stop', 'run-stop');
    const sStop = await seedObservedComputerSession(hStop);
    await hStop.runtime.control(sStop.subject, 'takeover');
    const pendingStop = hStop.handler.execute(
      {
        operation: 'act',
        targetApp: 'Notes',
        stateId: sStop.stateId,
        mutation: { kind: 'click', elementRef: 'e1' },
      },
      makeToolContext({ conversationId: hStop.conversationId, runId: hStop.runId, toolCallId: 'tc-stop' }),
      hStop.permit,
    );
    await vi.advanceTimersByTimeAsync(200);
    await hStop.runtime.control(sStop.subject, 'stop');
    await vi.advanceTimersByTimeAsync(150);
    await expect(pendingStop).resolves.toMatchObject({ ok: false, code: 'SURFACE_SESSION_BUSY' });
    expect(hStop.executeSpy).toHaveBeenCalledTimes(0);
    expect(isHumanWaitActive(hStop.conversationId)).toBe(false);

    // 2. end_session during wait
    const hEnd = createHarness('conv-end', 'run-end');
    const sEnd = await seedObservedComputerSession(hEnd);
    await hEnd.runtime.control(sEnd.subject, 'takeover');
    const pendingEnd = hEnd.handler.execute(
      {
        operation: 'act',
        targetApp: 'Notes',
        stateId: sEnd.stateId,
        mutation: { kind: 'click', elementRef: 'e1' },
      },
      makeToolContext({ conversationId: hEnd.conversationId, runId: hEnd.runId, toolCallId: 'tc-end' }),
      hEnd.permit,
    );
    await vi.advanceTimersByTimeAsync(200);
    await hEnd.runtime.control(sEnd.subject, 'end_session');
    await vi.advanceTimersByTimeAsync(150);
    await expect(pendingEnd).resolves.toMatchObject({ ok: false, code: 'SURFACE_SESSION_BUSY' });
    expect(hEnd.runtime.sessions.requireOwned(sEnd.subject.sessionId, sEnd.subject).state).toBe('completed');
    expect(hEnd.executeSpy).toHaveBeenCalledTimes(0);
    expect(isHumanWaitActive(hEnd.conversationId)).toBe(false);

    // 3. abortSignal during wait
    const hAbort = createHarness('conv-abort', 'run-abort');
    const sAbort = await seedObservedComputerSession(hAbort);
    await hAbort.runtime.control(sAbort.subject, 'takeover');
    const abortController = new AbortController();
    const pendingAbort = hAbort.handler.execute(
      {
        operation: 'act',
        targetApp: 'Notes',
        stateId: sAbort.stateId,
        mutation: { kind: 'click', elementRef: 'e1' },
      },
      makeToolContext({
        conversationId: hAbort.conversationId,
        runId: hAbort.runId,
        toolCallId: 'tc-abort',
        abortSignal: abortController.signal,
      }),
      hAbort.permit,
    );
    await vi.advanceTimersByTimeAsync(200);
    abortController.abort('user cancelled turn');
    await expect(pendingAbort).resolves.toMatchObject({ ok: false, code: 'SURFACE_REQUEST_CANCELLED' });
    expect(hAbort.executeSpy).toHaveBeenCalledTimes(0);
    expect(isHumanWaitActive(hAbort.conversationId)).toBe(false);
  });
});
