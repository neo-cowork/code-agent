import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger, ToolResult } from '../../../../../src/host/protocol/tools';

const execMock = vi.fn();
const getMock = vi.fn();

vi.mock('../../../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({ get: getMock }),
}));

import { calendarModule } from '../../../../../src/host/tools/modules/connectors/calendar';
import { mailModule } from '../../../../../src/host/tools/modules/connectors/mail';
import { remindersModule } from '../../../../../src/host/tools/modules/connectors/reminders';
import { withConnectorReconnectGuidance } from '../../../../../src/host/tools/dispatch/connectorReconnectGuidance';
import { projectLedgerMessage } from '../../../../../src/host/agent/runtime/contextAssembly/ledgerMessageProjection';
import { serializeToolResultsForModel } from '../../../../../src/host/tools/toolResultMessageContent';

// Text written for the model must never appear in the user-visible tool card `output`.
const INSTRUCTION_TEXT = /Tell the user|Do not quote|Relay this status|without quoting|in their own language|complete user-facing answer|Do not send them/i;

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = {
  sessionId: 's', workingDir: process.cwd(), abortSignal: new AbortController().signal,
  logger, emit: () => void 0,
} as unknown as ToolContext;
const allowAll: CanUseToolFn = async () => ({ allow: true });

const MODULES = [
  { tool: 'reminders', module: remindersModule },
  { tool: 'mail', module: mailModule },
  { tool: 'calendar', module: calendarModule },
] as const;

type State = { name: string; registered: boolean; status?: Record<string, unknown> };
const STATES: State[] = [
  { name: 'no connector registered', registered: false },
  { name: 'not connected', registered: true, status: { connected: false, capabilities: ['get_status'] } },
  { name: 'connected', registered: true, status: { connected: true, capabilities: ['get_status', 'list_events'] } },
  { name: 'calendar_restricted', registered: true, status: { connected: false, detailCode: 'calendar_restricted', capabilities: [] } },
  { name: 'automation_not_authorized', registered: true, status: { connected: false, detailCode: 'automation_not_authorized', capabilities: [] } },
];

async function finalResult(tool: string, module: typeof MODULES[number]['module'], state: State) {
  getMock.mockReturnValue(state.registered ? { execute: execMock } : undefined);
  execMock.mockResolvedValue({ data: state.status });
  const handler = await module.createHandler();
  const raw = await handler.execute({ action: 'get_status' }, ctx, allowAll);
  return withConnectorReconnectGuidance(tool, raw as ToolResult<unknown>) as Extract<ToolResult<unknown>, { ok: true }>;
}

describe('connector get_status output carries facts only', () => {
  beforeEach(() => {
    execMock.mockReset();
    getMock.mockReset();
  });

  for (const { tool, module } of MODULES) {
    for (const state of STATES) {
      it(`${tool} / ${state.name}: output has no model instruction, artifact preview too`, async () => {
        const result = await finalResult(tool, module, state);
        expect(result.ok).toBe(true);
        expect(typeof result.output).toBe('string');
        expect(result.output).not.toMatch(INSTRUCTION_TEXT);
        const artifact = result.meta?.artifact as { preview?: string } | undefined;
        expect(artifact?.preview ?? '').not.toMatch(INSTRUCTION_TEXT);
        expect(JSON.stringify(artifact ?? {})).not.toMatch(INSTRUCTION_TEXT);
      });

      it(`${tool} / ${state.name}: model JSON still carries the guidance, stored output does not`, async () => {
        const result = await finalResult(tool, module, state);
        const guidance = result.meta?.modelGuidance;
        expect(typeof guidance).toBe('string');
        const modelJson = serializeToolResultsForModel([
          { toolCallId: 't1', success: true, output: result.output as string, metadata: result.meta } as never,
        ]);
        const [entry] = JSON.parse(modelJson) as Array<{ output: string; metadata: Record<string, unknown> }>;
        if (result.meta?.modelGuidanceReplacesOutput !== true) expect(entry.output).toContain(result.output as string);
        expect(entry.output).toContain(guidance as string);
        expect(entry.metadata).not.toHaveProperty('modelGuidance');
        expect(entry.metadata).not.toHaveProperty('modelGuidanceReplacesOutput');
        expect(result.output).not.toContain(guidance as string);
      });
    }
  }

  it('the model-message projection (what providers send) carries the guidance while stored output stays clean', async () => {
    const result = await finalResult('reminders', remindersModule, STATES[1]);
    const guidance = result.meta?.modelGuidance as string;
    const [projected] = projectLedgerMessage({
      id: 'm1', role: 'tool', content: '', timestamp: 0,
      toolResults: [{ toolCallId: 't1', success: true, output: result.output as string, metadata: result.meta }],
    } as never);
    expect(projected.content).toContain(guidance);
    expect(result.output).not.toContain(guidance);
  });

  it('calendar_restricted guidance still tells the model not to send the user to the Connectors page', async () => {
    const result = await finalResult('calendar', calendarModule, STATES[3]);
    expect(result.meta?.modelGuidance).toContain('Do not send them to the Connectors page');
  });
});
