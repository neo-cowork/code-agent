// Evidence class: hermetic-protocol (SQLite durable kernel + production engine/resolver/mail_draft tool/continuation/IPC; fake Mail connector + fake TCC bridge).
// N-ENV-ASSIST-S3-RESUME-REST2: a refused Mail draft parks the run; after the grant the host records a plain
// "not run" result for the parked call and resumes the same run; the model saves the draft exactly once.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import type { Message } from '../../../../src/shared/contract';
import type { PassiveBridge } from '../../../../src/host/permissions/envAssist/probes/types';

const store = vi.hoisted(() => ({ bridge: null as PassiveBridge | null, db: {} as Record<string, unknown> }));
vi.mock('../../../../src/host/services/core/databaseService', () => ({ getDatabase: () => store.db }));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async (sessionId: string) => (store.db.getMessages as ((id: string) => Message[]) | undefined)?.(sessionId) ?? [],
    addMessageToSession: async () => undefined,
  }),
}));
vi.mock('../../../../src/host/services/agentEngine/agentEngineEventSink', () => ({ emitExternalAgentEvent: () => undefined }));
vi.mock('../../../../src/host/permissions/envAssist/settingsPane', () => ({ canOpenEnvSettings: () => true, openEnvSettings: vi.fn(async () => true) }));
// Only the bridge handle is faked; with no bridge the real resolver runs so its degrade log is the evidence.
vi.mock('../../../../src/host/permissions/envAssist/shellBridge/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/permissions/envAssist/shellBridge/client')>();
  return { ...actual, resolveShellBridgeClientFromEnv: (...args: Parameters<typeof actual.resolveShellBridgeClientFromEnv>) => (store.bridge ? {} as never : actual.resolveShellBridgeClientFromEnv(...args)) };
});
vi.mock('../../../../src/host/permissions/envAssist/probes/shellPassiveBridge', () => ({ createShellPassiveBridge: () => store.bridge }));
const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/services/infra/logger')>(),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn }),
}));

import { harness, databasePorts } from './envResumeHarness';
import { registerEnvResumeContinuer } from '../../../../src/host/runtime/envResumeWaiter';
import { ENV_RESUME_POLL_INTERVAL_MS, ENV_RESUME_TIMEOUT_MS } from '../../../../src/shared/constants/envResume';
import { envResumeProbeFactory } from '../../../../src/host/ipc/envAssist.ipc';

const asked: string[] = [];
const mailBridge = (code: 0 | -1743 | -1744): PassiveBridge => ({
  AXIsProcessTrusted: async () => false, CGPreflightScreenCaptureAccess: async () => false, IOHIDCheckAccess: async () => 1,
  AEDeterminePermissionToAutomateTarget: async (bundleId: string) => { asked.push(bundleId); return code; },
  EKAuthorizationStatusForEvents: async () => 0,
});

let fixture: Awaited<ReturnType<typeof harness>> | undefined;
let workspace = '';
afterEach(() => {
  fixture?.close(); fixture = undefined; registerEnvResumeContinuer(null); vi.useRealTimers(); vi.restoreAllMocks();
  warn.mockClear(); store.bridge = null; asked.length = 0;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

async function parkedMail() {
  vi.useFakeTimers();
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'env-resume-mail-')));
  fixture = await harness(workspace, ':memory:', false, false, true);
  store.db = databasePorts.current;
  return fixture;
}
async function settled(f: NonNullable<typeof fixture>) {
  const stopped = () => warn.mock.calls.some(([message, data]) => message === 'Environment auto-continue stopped'
    && (data as { reason?: string } | undefined)?.reason !== 'timeout');
  await vi.waitFor(() => expect(f.counts().resumes > 0 || stopped()).toBe(true), { timeout: 5000 });
}
const toolTexts = (f: NonNullable<typeof fixture>) => f.messages().filter((m) => m.role === 'tool').flatMap((m) => m.toolResults ?? []);

describe('② a refused Mail draft parks the run and shows the Mail card', () => {
  it('parks with interruptCause env_blocked / target mail, no tool result for the model, card is perm_automation', async () => {
    const f = await parkedMail();
    f.wire(async () => 'red');
    const { emitted } = await f.park();
    const envelope = await f.repository.get('env-run');
    process.stdout.write(`DURABLE_ENVELOPE ${JSON.stringify(envelope)}\n`);
    expect(envelope).toMatchObject({ status: 'waiting', interruptCause: 'env_blocked', envBlocked: { class: 'perm_automation', target: 'mail', toolCallId: 'env-call' } });
    expect(toolTexts(f)).toHaveLength(0);
    const card = emitted.find((e) => e.type === 'env_assist_notice')?.data as { phase: string };
    process.stdout.write(`CARD ${JSON.stringify(card)}\n`);
    expect(card).toMatchObject({ class: 'perm_automation', phase: 'needs_user', parkedToolCallId: 'env-call', target: { id: 'mail' } });
    expect(f.mailSaved()).toEqual({ attempts: 1, saved: 0 });
  });
});

describe('③ the grant resumes the same run; the draft is saved once, without a new user message', () => {
  it('records a plain not-run result for the parked call, then exactly one mail_draft succeeds', async () => {
    const f = await parkedMail();
    let granted = false;
    f.wire(async () => granted ? 'green' : 'red');
    await f.park();
    await vi.advanceTimersByTimeAsync(ENV_RESUME_POLL_INTERVAL_MS);
    expect(f.counts().resumes).toBe(0);
    f.green(); granted = true;
    await vi.advanceTimersByTimeAsync(ENV_RESUME_POLL_INTERVAL_MS);
    await settled(f);
    expect(warn).not.toHaveBeenCalledWith('Environment auto-continue stopped', expect.anything());
    const results = toolTexts(f);
    process.stdout.write(`TOOL_RESULTS ${JSON.stringify(results)}\n`);
    const parked = results.find((r) => r.toolCallId === 'env-call')!;
    expect(parked.success).toBe(false);
    expect(parked.error).toContain('not run: Mail automation permission was missing');
    expect(parked.error).toContain('nothing was saved');
    expect(parked.error).toContain('now granted');
    expect(parked.error).toContain('Call this tool again once with the same arguments');
    expect(parked.error).not.toContain('crashed');
    expect(results.filter((r) => r.toolCallId === 'env-call-2' && r.success)).toHaveLength(1);
    expect(f.mailSaved()).toEqual({ attempts: 2, saved: 1 });
    expect(f.messages().filter((m) => m.role === 'user')).toHaveLength(1);
    expect((await f.repository.get('env-run'))?.status).toBe('completed');
  });

  it('⑤ counts the approval prompts the user sees for the one draft (the harness executor approves every prompt and records it)', async () => {
    const f = await parkedMail();
    f.wire(async () => 'green');
    await f.park();
    f.green();
    await vi.advanceTimersByTimeAsync(ENV_RESUME_POLL_INTERVAL_MS);
    await settled(f);
    const reissued = toolTexts(f).find((r) => r.toolCallId === 'env-call-2');
    process.stdout.write(`APPROVAL_PROMPTS reissued=${JSON.stringify(reissued)}\n`);
    expect(reissued?.success).toBe(true);
    process.stdout.write(`APPROVAL_CARDS ${JSON.stringify(f.approvalCards())}\n`);
    // No automatic reuse exists for a one-time allow (allow_run/allow_24h are explicit user tiers): the user sees two cards for the one draft.
    expect(f.approvalCards()).toEqual(['mail_draft', 'mail_draft']);
  });
});

describe('① probe factory and bridge-less web build', () => {
  it('target mail resolves to com.apple.mail on the passive bridge (granted → green, refused → red, undecided → red)', async () => {
    store.bridge = mailBridge(0);
    const block = { class: 'perm_automation' as const, target: 'mail', toolCallId: 'c' };
    expect(await envResumeProbeFactory(block)()).toBe('green');
    store.bridge = mailBridge(-1743);
    expect(await envResumeProbeFactory(block)()).toBe('red');
    store.bridge = mailBridge(-1744);
    expect(await envResumeProbeFactory(block)()).toBe('red');
    expect(new Set(asked)).toEqual(new Set(['com.apple.mail']));
  });

  it('without a native bridge the degrade is logged with its reason, the run stops waiting, manual Continue still works', async () => {
    const saved = { ...process.env };
    delete process.env.CODE_AGENT_SHELL_BRIDGE_URL; delete process.env.CODE_AGENT_SHELL_BRIDGE_TOKEN;
    try {
      const f = await parkedMail();
      f.wire(envResumeProbeFactory({ class: 'perm_automation', target: 'mail', toolCallId: 'env-call' }));
      await f.park();
      await vi.advanceTimersByTimeAsync(ENV_RESUME_POLL_INTERVAL_MS * 2);
      const lines = warn.mock.calls.filter(([m]) => String(m).startsWith('env_assist_bridge:no_shell'));
      process.stdout.write(`DEGRADE_LOG ${JSON.stringify(lines)}\n`);
      expect(lines.map(([m]) => m)).toContain('env_assist_bridge:no_shell');
      expect(lines.find(([m]) => m === 'env_assist_bridge:no_shell_reason')?.[1]).toMatchObject({ reason: expect.stringMatching(/^[a-z_]+$/) });
      expect(f.counts().resumes).toBe(0);
      expect((await f.repository.get('env-run'))?.status).toBe('waiting');
      await vi.advanceTimersByTimeAsync(ENV_RESUME_TIMEOUT_MS + 1);
      f.green();
      await f.continueRun();
      await settled(f);
      expect(f.mailSaved().saved).toBe(1);
    } finally { Object.assign(process.env, saved); }
  });
});
