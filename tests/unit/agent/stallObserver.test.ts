import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearStreamProgress,
  holdStallClock,
  stallClockHeld,
  startForegroundStallWatch,
  streamProgressOf,
  type StallPhase,
} from '../../../src/host/agent/stallObserver';
import { createSubagentTurnObservability } from '../../../src/host/agent/subagentTurnTrace';
import { isAgentRowQuiet } from '../../../src/renderer/utils/agentRowStall';
import type { AgentRow } from '../../../src/renderer/utils/agentRows';

function quietWatch(detail: string) {
  const emit = vi.fn();
  const clear = vi.fn();
  let now = 0;
  let progressKey = 'boot';
  let phase: StallPhase = 'tool';
  let held = false;
  let currentDetail = detail;
  const stop = startForegroundStallWatch({
    snapshot: () => ({ progressKey, phase, detail: currentDetail, held }),
    emit,
    clear,
    now: () => now,
    intervalMs: 1_000,
  });
  return {
    emit,
    clear,
    stop,
    at(next: number, patch?: { progressKey?: string; phase?: StallPhase; held?: boolean; detail?: string }) {
      now = next;
      if (patch?.progressKey) progressKey = patch.progressKey;
      if (patch?.phase) phase = patch.phase;
      if (patch?.held !== undefined) held = patch.held;
      if (patch?.detail) currentDetail = patch.detail;
      vi.advanceTimersByTime(1_000);
    },
  };
}

describe('StallObserver', () => {
  it('hints after N_SOFT_MS (120s) and escalates at 5min while a tool is quiet', () => {
    vi.useFakeTimers();
    const watch = quietWatch('Read');
    watch.at(0);
    watch.at(120_000);
    expect(watch.emit).not.toHaveBeenCalled();
    watch.at(121_000);
    expect(watch.emit).toHaveBeenCalledWith({ level: 'hint', phase: 'tool', detail: 'Read' });
    watch.at(180_000);
    expect(watch.emit).toHaveBeenCalledTimes(1);
    watch.at(300_000);
    expect(watch.emit).toHaveBeenLastCalledWith({ level: 'escalated', phase: 'tool', detail: 'Read' });
    watch.stop();
  });

  it('resets the clock when something visible happens', () => {
    vi.useFakeTimers();
    const watch = quietWatch('Read');
    watch.at(0);
    watch.at(80_000, { progressKey: 'tool:1', phase: 'model', detail: '等模型回响' });
    watch.at(200_000);
    expect(watch.emit).not.toHaveBeenCalled();
    watch.at(201_000);
    expect(watch.emit).toHaveBeenCalledWith({
      level: 'hint', phase: 'model', detail: '等模型回响',
    });
    watch.stop();
  });

  it('a decision wait does not keep the idle clock running', () => {
    vi.useFakeTimers();
    const watch = quietWatch('Bash');
    watch.at(0);
    watch.at(121_000);
    expect(watch.emit).toHaveBeenCalledTimes(1);
    watch.at(4 * 60_000, { held: true });
    expect(watch.emit).toHaveBeenCalledTimes(1);
    watch.at(4 * 60_000 + 120_000, { held: false });
    expect(watch.emit).toHaveBeenCalledTimes(1);
    watch.at(4 * 60_000 + 121_000);
    expect(watch.emit).toHaveBeenLastCalledWith({ level: 'hint', phase: 'tool', detail: 'Bash' });
    watch.stop();
  });

  it('holds the session clock only while a decision is open', () => {
    expect(stallClockHeld('session-a')).toBe(false);
    const release = holdStallClock('session-a');
    const nested = holdStallClock('session-a');
    expect(stallClockHeld('session-a')).toBe(true);
    release();
    expect(stallClockHeld('session-a')).toBe(true);
    nested();
    expect(stallClockHeld('session-a')).toBe(false);
    expect(holdStallClock(undefined)()).toBeUndefined();
  });

  it('does not escalate across a decision that was open the whole time', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const clear = vi.fn();
    let held = false;
    let now = 0;
    const stop = startForegroundStallWatch({
      snapshot: () => ({ progressKey: 'same', phase: 'tool', detail: 'Bash', held }),
      emit,
      clear,
      now: () => now,
      intervalMs: 1_000,
    });
    vi.advanceTimersByTime(1_000);
    expect(emit).not.toHaveBeenCalled();
    now = 121_000;
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledTimes(1);
    const clearsBeforeHold = clear.mock.calls.length;
    held = true;
    now = 400_000;
    vi.advanceTimersByTime(1_000);
    expect(clear.mock.calls.length).toBe(clearsBeforeHold + 1);
    expect(emit).toHaveBeenCalledTimes(1);
    held = false;
    now = 430_000;
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps composer stall watch and expert row quiet check aligned on approval release and foreground child progress', async () => {
    vi.useFakeTimers();
    const sessionId = 'session-parent-fu1';
    clearStreamProgress(sessionId);

    const observability = createSubagentTurnObservability({
      sessionId,
      identity: { agentId: 'agent_coder_1', runId: 'run_1', parentToolUseId: 'call_spawn_1' },
      events: { emit: () => {} },
      workingDirectory: process.cwd(),
      warn: () => {},
    });

    const emit = vi.fn();
    const clear = vi.fn();
    let now = 0;
    let held = true;
    let lastChildToolAt = 0;

    const currentRow = (): AgentRow => ({
      key: 'agent_coder_1',
      kind: 'agent',
      name: 'coder',
      isLead: false,
      status: 'working',
      stoppable: true,
      hold: held ? 'approval' : undefined,
      node: {
        id: 'agent_coder_1',
        role: 'coder',
        status: 'running',
        statusLabel: '正在处理',
        children: [],
        worktreeState: { status: 'none' },
        budgetSummary: {},
        evidenceRefs: [],
        sources: ['spawnGuard'],
        createdAt: 0,
        updatedAt: lastChildToolAt,
        lastToolStep: lastChildToolAt > 0 ? { tool: 'Bash', at: lastChildToolAt } : undefined,
      },
    });

    const stop = startForegroundStallWatch({
      snapshot: () => ({
        progressKey: `1:0:1:0:${streamProgressOf(sessionId)}`,
        phase: 'tool',
        detail: 'spawn_agent',
        held,
      }),
      emit,
      clear,
      now: () => now,
      intervalMs: 1_000,
    });

    const stepTo = (targetMs: number) => {
      now = targetMs;
      vi.advanceTimersByTime(1_000);
    };

    // Held on child Bash approval until t = 30s, then user clicks Allow at t = 30s
    stepTo(15_000);
    const releaseAt = 30_000;
    held = false;
    stepTo(releaseAt);

    // At release + 90s (t = 120s), check composer hint vs row quiet
    stepTo(releaseAt + 90_000);
    const composerHintedAtReleasePlus90s = emit.mock.calls.length > 0;
    const rowQuietAtReleasePlus90s = isAgentRowQuiet(currentRow(), now, releaseAt);

    // At release + 120s (t = 150s), still at boundary: row is not quiet; at release + 121s (t = 151s), both agree
    stepTo(releaseAt + 120_000);
    const rowQuietAtReleasePlus120s = isAgentRowQuiet(currentRow(), now, releaseAt);
    stepTo(releaseAt + 121_000);
    const composerHintedAtReleasePlus121s = emit.mock.calls.length > 0;
    const rowQuietAtReleasePlus121s = isAgentRowQuiet(currentRow(), now, releaseAt);

    // Now child makes visible tool progress at t = 160s: both composer and row reset their quiet window
    const clearsBeforeChildTool = clear.mock.calls.length;
    now = 160_000;
    lastChildToolAt = now;
    const parentProgressBeforeChildTool = streamProgressOf(sessionId);
    await observability.recordToolResult(
      { id: 'bash-1', name: 'Bash', arguments: { command: 'printf ok' } },
      { success: true, output: 'ok' },
      12,
    );
    const parentProgressAfterChildTool = streamProgressOf(sessionId);
    stepTo(160_000);
    const clearedOnChildTool = clear.mock.calls.length > clearsBeforeChildTool;

    const emitsAfterChildTool = emit.mock.calls.length;
    stepTo(160_000 + 90_000);
    const composerRehinted90sAfterChildStep = emit.mock.calls.length > emitsAfterChildTool;
    const rowQuiet90sAfterChildStep = isAgentRowQuiet(currentRow(), now, releaseAt);

    const backgroundObservability = createSubagentTurnObservability({
      sessionId,
      identity: { agentId: 'agent_coder_bg', runId: 'run_bg', parentToolUseId: 'call_spawn_bg' },
      events: { backgroundDurableAgentId: 'task-bg', emit: () => {} },
      workingDirectory: process.cwd(),
      warn: () => {},
    });
    const parentProgressBeforeBackgroundTool = streamProgressOf(sessionId);
    await backgroundObservability.recordToolResult(
      { id: 'bash-bg', name: 'Bash', arguments: { command: 'printf background' } },
      { success: true, output: 'background' },
      8,
    );
    const backgroundChildIgnoredByParentProgress = streamProgressOf(sessionId)
      === parentProgressBeforeBackgroundTool;

    stop();
    clearStreamProgress(sessionId);

    const timeline = {
      composerHintedAtReleasePlus90s,
      rowQuietAtReleasePlus90s,
      rowQuietAtReleasePlus120s,
      composerHintedAtReleasePlus121s,
      rowQuietAtReleasePlus121s,
      childToolBumpedParentProgress: parentProgressAfterChildTool > parentProgressBeforeChildTool,
      clearedOnChildTool,
      composerRehinted90sAfterChildStep,
      rowQuiet90sAfterChildStep,
      backgroundChildIgnoredByParentProgress,
    };
    process.stdout.write(`[stall-alignment] ${JSON.stringify(timeline)}\n`);
    expect(timeline).toEqual({
      composerHintedAtReleasePlus90s: false,
      rowQuietAtReleasePlus90s: false,
      rowQuietAtReleasePlus120s: false,
      composerHintedAtReleasePlus121s: true,
      rowQuietAtReleasePlus121s: true,
      childToolBumpedParentProgress: true,
      clearedOnChildTool: true,
      composerRehinted90sAfterChildStep: false,
      rowQuiet90sAfterChildStep: false,
      backgroundChildIgnoredByParentProgress: true,
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
});
