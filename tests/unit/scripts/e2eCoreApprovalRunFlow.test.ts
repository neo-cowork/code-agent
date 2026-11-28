import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { f07 } from '../../../scripts/e2e-core/approvalRunFlow';
import type { AttemptEnv, DbSnapshot } from '../../../scripts/e2e-core/types';
import { sleep } from '../../../scripts/e2e-core/ui';

vi.mock('../../../scripts/e2e-core/ui', () => ({
  approveCard: vi.fn(),
  clickCardButton: vi.fn(),
  driveTurn: vi.fn(),
  openNewSession: vi.fn(),
  sendMessage: vi.fn(),
  sleep: vi.fn(),
}));

// Relevant fields from the 2026-11-27 nightly db-50.json.
const attempt3Session = 'session_1795788335959_defa1804';
const attempt3Decisions = [
  {
    summary: 'pwd',
    recorded_at: 1795788351557,
    final_outcome: 'allow',
    history_outcome: 'auto-approve',
    reason: 'safe-command',
  },
  {
    summary: 'curl -sSL https://example.com -o a.html',
    recorded_at: 1795788354407,
    final_outcome: 'allow',
    history_outcome: 'ask-approved',
    reason: 'user',
  },
  {
    summary: 'curl -sSL https://example.org -o b.html',
    recorded_at: 1795788357008,
    final_outcome: 'allow',
    history_outcome: 'auto-approve',
    reason: 'tool_grant:run',
  },
  {
    summary: `ls -l a.html b.html | awk '{print $9, $5" bytes"}'`,
    recorded_at: 1795788360695,
    final_outcome: 'allow',
    history_outcome: 'auto-approve',
    reason: 'safe-command',
  },
].map((row) => ({ ...row, session_id: attempt3Session, tool_name: 'Bash' }));
const attempt3Begins = [
  {
    command: 'pwd',
    description: 'Confirm current working directory',
  },
  {
    command: 'curl -sSL https://example.com -o a.html',
    description: 'Fetch example.com into a.html',
  },
  {
    command: 'curl -sSL https://example.org -o b.html',
    description: 'Fetch example.org into b.html',
  },
  {
    command: `ls -l a.html b.html | awk '{print $9, $5" bytes"}'`,
    description: 'Check file existence and sizes',
  },
].map((params) => ({
  params_json: JSON.stringify(params),
  session_id: attempt3Session,
  tool_name: 'Bash',
  phase: 'begin',
}));

const attempt2Session = 'session_1795788283444_2d61ad8b';
const attempt2Decisions = [
  {
    summary: 'curl -sSL --max-time 30 https://example.com -o a.html; echo "exit=$?"; ls -l a.h',
    recorded_at: 1795788313456,
    final_outcome: 'allow',
    history_outcome: 'ask-approved',
    reason: 'user',
  },
  {
    summary: 'curl -sSL --max-time 30 https://example.org -o b.html; echo "exit=$?"; ls -l a.h',
    recorded_at: 1795788316205,
    final_outcome: 'allow',
    history_outcome: 'auto-approve',
    reason: 'tool_grant:run',
  },
].map((row) => ({ ...row, session_id: attempt2Session, tool_name: 'Bash' }));
const attempt2Begins = [
  {
    command: 'curl -sSL --max-time 30 https://example.com -o a.html; echo "exit=$?"; ls -l a.html',
    description: 'Fetch example.com into a.html',
  },
  {
    command: 'curl -sSL --max-time 30 https://example.org -o b.html; echo "exit=$?"; ls -l a.html b.html',
    description: 'Fetch example.org into b.html',
  },
].map((params) => ({
  params_json: JSON.stringify(params),
  session_id: attempt2Session,
  tool_name: 'Bash',
  phase: 'begin',
}));

function createStepEnv(
  sessionId: string,
  permissionDecisions: DbSnapshot['permissionDecisions'],
  toolEvents: DbSnapshot['toolEvents'],
): AttemptEnv {
  return {
    page: {} as AttemptEnv['page'],
    server: {} as AttemptEnv['server'],
    sessionIds: [sessionId],
    startedAtMs: 0,
    sseFile: 'test.sse',
    scratch: {},
    note: vi.fn(),
    readDb: vi.fn(async () => ({
      file: 'db-50.json',
      data: {
        sessions: [{ id: sessionId }],
        messages: [],
        toolEvents,
        pendingApprovals: [],
        permissionDecisions,
        cronJobs: [],
        cronExecutions: [],
      },
    })),
  };
}

describe('e2e-core F07 approvalRunFlow step 4', () => {
  const step = f07.steps[3];
  const [pwd, card, grant, fileCheck] = attempt3Decisions;

  beforeEach(() => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async (ms) => { now += ms; });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(a) accepts nightly attempt 3 with pwd before the card', async () => {
    const env = createStepEnv(attempt3Session, attempt3Decisions, attempt3Begins);
    await expect(step.run(env)).resolves.toBeUndefined();
  });

  it('(b) accepts nightly attempt 2 with the card first', async () => {
    const env = createStepEnv(attempt2Session, attempt2Decisions, attempt2Begins);
    await expect(step.run(env)).resolves.toBeUndefined();
  });

  it('(c) rejects a grant hit without an ask row', async () => {
    const env = createStepEnv(attempt3Session, [pwd, grant], attempt3Begins);
    await expect(step.run(env)).rejects.toThrow('首条 Bash 询问记录缺失');
  });

  it('(d) rejects a grant hit recorded before the card', async () => {
    const earlyGrant = { ...grant, recorded_at: pwd.recorded_at };
    const env = createStepEnv(attempt3Session, [card, grant, earlyGrant], attempt3Begins);
    await expect(step.run(env)).rejects.toThrow('审批卡之前有 Bash 未放行或提前命中授权记忆');
  });

  it('(e) rejects a second ask-approved row after the card', async () => {
    const secondAsk = { ...card, summary: fileCheck.summary, recorded_at: fileCheck.recorded_at };
    const env = createStepEnv(attempt3Session, [pwd, card, grant, secondAsk], attempt3Begins);
    await expect(step.run(env)).rejects.toThrow('审批卡之后还有 Bash 再问了用户');
  });

  it('(f) rejects a card without a later run grant hit', async () => {
    const env = createStepEnv(attempt3Session, [pwd, card, fileCheck], attempt3Begins);
    await expect(step.run(env)).rejects.toThrow('后续 Bash 调用没有命中授权记忆');
  });

  it('(g) reports a model branch for pwd plus one curl begin', async () => {
    const env = createStepEnv(attempt3Session, [pwd, card], attempt3Begins.slice(0, 2));
    await expect(step.run(env)).rejects.toThrow(/Bash\/curl begin 只有 1 次.*模型分支/);
    expect(env.readDb).toHaveBeenCalledTimes(1);
  });
});
