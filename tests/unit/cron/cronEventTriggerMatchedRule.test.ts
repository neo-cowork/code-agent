import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '../../../src/shared/contract/channel';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import type { CronEventDecisionInput } from '../../../src/host/cron/cronEventDecisionLedger';
import { CronEventTrigger, type CronEventChannelSource } from '../../../src/host/cron/cronEventTrigger';

const { getAccount } = vi.hoisted(() => ({ getAccount: vi.fn() }));
vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => ({ getAccount }),
}));

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const CHAT_ID = 'weekly-reports';
const EVENT_ID = 'weekly-report-message';
const NAMED_RULE = 'channel message · account Feishu A · chat Weekly reports';
const OMIT_ACCOUNT_RULE = 'channel message · chat Weekly reports';
const NOW = Date.UTC(2026, 10, 26);
const BATCH_WINDOW_SECONDS = 10;

let trigger: CronEventTrigger | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  getAccount.mockReset().mockImplementation((id: string) => id === ACCOUNT_ID ? { name: ' Feishu A ' } : undefined);
});

afterEach(() => {
  trigger?.dispose();
  vi.useRealTimers();
});

function listen(prefilter?: string) {
  const job: CronJobDefinition = {
    id: 'weekly-report-job',
    name: 'Summarize weekly reports',
    scheduleType: 'event',
    schedule: {
      type: 'event', source: 'channel', accountId: ACCOUNT_ID, chatId: CHAT_ID,
      eventName: 'message', batchWindowSec: BATCH_WINDOW_SECONDS, prefilter,
    },
    action: { type: 'agent', agentType: 'default', prompt: 'Summarize new weekly reports' },
    actionMode: 'auto',
    runsOn: 'local', maxRunBudget: 1, enabled: true, createdAt: NOW, updatedAt: NOW,
  };
  const message: ChannelMessage = {
    id: EVENT_ID,
    channelId: 'feishu',
    sender: { id: 'sender', name: 'Taylor' },
    context: { chatId: CHAT_ID, chatType: 'group', chatName: ' Weekly reports ' },
    content: 'Here is this week’s report.',
    timestamp: NOW,
    ingressAuth: 'paired',
  };
  const rows: CronEventDecisionInput[] = [];
  const source = new EventEmitter();
  const executeEventJob = vi.fn(async () => ({
    id: 'weekly-report-run',
    status: 'completed',
    result: { eventDecisions: [{ eventId: EVENT_ID, action: 'act', reason: 'A weekly report arrived' }] },
  }));
  trigger = new CronEventTrigger({
    host: { getJobDefinitions: () => [job], isJobInFlight: () => false, executeEventJob },
    channelSource: source as unknown as CronEventChannelSource,
    decisionStore: {
      record: (batch) => { rows.push(...batch); },
      countActionsForRun: () => 0,
    },
    prefilterJudge: async () => ({
      success: true,
      content: JSON.stringify([{ id: EVENT_ID, match: false, reason: 'The report is for a different team' }]),
    }),
  });
  trigger.start();
  source.emit('listen_message', ACCOUNT_ID, message);
  return { job, rows, executeEventJob };
}

function flush() {
  return vi.advanceTimersByTimeAsync(BATCH_WINDOW_SECONDS * 1_000);
}

function expectRule(rows: CronEventDecisionInput[], decision: CronEventDecisionInput['decision'], rule: string) {
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'event', eventId: EVENT_ID, decision });
  expect(rows[0].matchedRule).toBe(rule);
  expect(rows[0].matchedRule).not.toContain(ACCOUNT_ID);
}

describe('group-listen event decision rules', () => {
  it('records the account name when settling a run', async () => {
    const { rows, executeEventJob } = listen();
    await flush();
    expect(executeEventJob).toHaveBeenCalledOnce();
    expectRule(rows, 'acted', NAMED_RULE);
  });

  it('records the account name when the prefilter ignores the message', async () => {
    const { rows, executeEventJob } = listen('Only reports from my team');
    await flush();
    expect(executeEventJob).not.toHaveBeenCalled();
    expectRule(rows, 'ignored', NAMED_RULE);
  });

  it('records the account name when automation is disabled within the batch window', async () => {
    const { job, rows, executeEventJob } = listen();
    job.enabled = false;
    await flush();
    expect(executeEventJob).not.toHaveBeenCalled();
    expectRule(rows, 'dropped', NAMED_RULE);
  });

  it('omits the account when it is deleted within the batch window', async () => {
    const { rows } = listen();
    getAccount.mockReturnValue(undefined);
    await flush();
    expectRule(rows, 'acted', OMIT_ACCOUNT_RULE);
  });

  it('omits the account when its name is blank', async () => {
    getAccount.mockReturnValue({ name: '  ' });
    const { rows } = listen();
    await flush();
    expectRule(rows, 'acted', OMIT_ACCOUNT_RULE);
  });
});
