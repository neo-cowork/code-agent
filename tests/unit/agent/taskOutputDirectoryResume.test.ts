// 续跑/重启后，用户点名的输出目录在 Bash 沙箱里仍可写。
// 走生产入口：AgentLoop.run（真实 withTaskOutputDirectory 接线）→ 真实 ToolExecutor → 真实 Bash handler →
// 真实 macOS seatbelt。只替身模型回合本身（ConversationRuntime.run 里直接发 Bash 工具调用）。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

const probe = vi.hoisted(() => ({
  command: '',
  sessionId: '',
  result: undefined as undefined | { success?: boolean; error?: string; output?: string; metadata?: unknown },
  infos: [] as Array<{ message: string; meta: unknown }>,
  execute: undefined as undefined | ((command: string, sessionId: string) => Promise<never>),
}));

vi.mock('../../../src/host/agent/runtime/conversationRuntime', () => ({
  ConversationRuntime: class {
    constructor(private readonly ctx: RuntimeContext) {}
    setModules(): void {}
    async run(): Promise<void> {
      probe.result = await (probe.execute as (c: string, s: string) => Promise<never>)(probe.command, this.ctx.sessionId ?? '');
    }
    wasInterrupted(): boolean { return false; }
  },
}));
vi.mock('../../../src/host/agent/runtime/toolExecutionEngine', () => ({
  ToolExecutionEngine: class { setModules(): void {} resetRepairGate(): void {} },
}));
vi.mock('../../../src/host/agent/runtime/contextAssembly', () => ({ ContextAssembly: class { setModules(): void {} } }));
vi.mock('../../../src/host/agent/runtime/runFinalizer', () => ({ RunFinalizer: class { setModules(): void {} } }));
vi.mock('../../../src/host/agent/runtime/learningPipeline', () => ({ LearningPipeline: class {} }));
vi.mock('../../../src/host/agent/runtime/runtimeStatePersistence', () => ({ loadPersistedRuntimeState: vi.fn(() => null) }));
vi.mock('../../../src/host/agent/runtime/scaffoldProfile', () => ({
  resolveScaffoldProfileForModel: vi.fn(() => ({ tier: 'standard', auditNudgeIntervalMultiplier: 1 })),
}));
vi.mock('../../../src/host/agent/runtime/turnCostPersistence', () => ({
  createTurnCostEventHandler: vi.fn(({ onEvent }: { onEvent: (event: unknown) => void }) => onEvent),
}));
vi.mock('../../../src/host/agent/persistentRoleResolution', () => ({ resolvePersistentRoleId: vi.fn(async () => undefined) }));
vi.mock('../../../src/host/agent/capabilityGapTurnRecorder', () => ({ recordCapabilityGapTurn: vi.fn(async () => undefined) }));
vi.mock('../../../src/host/services/cloud/featureFlagService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMaxIterations: vi.fn(() => 1),
}));
vi.mock('../../../src/host/services/skills/comboRecorder', () => ({
  getComboRecorder: () => ({ startRecording: vi.fn(), markTurn: vi.fn() }),
}));
vi.mock('../../../src/host/context/autoCompressor', () => ({ getAutoCompressor: vi.fn(() => ({})) }));
vi.mock('../../../src/host/telemetry/telemetryAdapter', () => ({ createTelemetryAdapter: vi.fn(() => ({})) }));
vi.mock('../../../src/host/agent/metricsCollector', () => ({ composeTelemetryAdapters: vi.fn((adapter: unknown) => adapter) }));
vi.mock('../../../src/host/services/infra/logger', () => {
  const log = {
    info: (message: string, meta?: unknown) => { probe.infos.push({ message, meta }); },
    debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };
  return { createLogger: vi.fn(() => log), logger: log, LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } };
});
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: () => Promise.resolve(null),
}));

import { AgentLoop } from '../../../src/host/agent/agentLoop';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getSandboxManager } from '../../../src/host/sandbox';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

const sandboxReady = process.platform === 'darwin' && getSandboxManager().isAvailable();
const suite = sandboxReady ? describe : describe.skip;
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const APPLIED = 'Task output directory applied to shell sandbox';

suite('named output directory survives resume / restart (real AgentLoop.run + real seatbelt)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-resume-data-'));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neo-resume-ws-')));
  // Outside cwd and outside the temp roots the sandbox always allows.
  const outDir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.neo-resume-成品-')));
  const originalSandbox = process.env.OS_SANDBOX_ENABLED;
  let n = 0;
  let sessionId: string;

  beforeAll(() => {
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    process.env.OS_SANDBOX_ENABLED = 'true';
    getProtocolRegistry();
    probe.execute = async (command, sid) => {
      const executor = new ToolExecutor({
        workingDirectory: workspace,
        requestPermission: async () => ({ approved: false, denialSource: 'user' as const }),
      });
      executor.setAuditEnabled(false);
      return executor.execute('Bash', { command }, { sessionId: sid, abortSignal: new AbortController().signal }) as never;
    };
  });
  afterAll(() => {
    delete process.env.CODE_AGENT_DATA_DIR;
    if (originalSandbox === undefined) delete process.env.OS_SANDBOX_ENABLED;
    else process.env.OS_SANDBOX_ENABLED = originalSandbox;
    for (const dir of [dataDir, workspace, outDir]) fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    sessionId = `resume-session-${++n}`;
    probe.infos.length = 0;
    probe.result = undefined;
    resetPermissionModeManager();
    getPermissionModeManager().setSessionMode(sessionId, 'bypassPermissions', true);
  });

  async function runTurn(text: string, command: string, extra: { isMeta?: boolean; sid?: string; delegationOrigin?: unknown } = {}) {
    probe.command = command;
    const sid = extra.sid ?? sessionId;
    const loop = new AgentLoop({
      modelConfig: { provider: 'mock', model: 'test-model', apiKey: 'test' },
      toolExecutor: {} as never,
      messages: [{ id: `u-${++n}`, role: 'user', content: text, timestamp: 1, isMeta: extra.isMeta } as never],
      onEvent: vi.fn(),
      workingDirectory: workspace,
      sessionId: sid,
      enableHooks: false,
      ...(extra.delegationOrigin ? { delegationOrigin: extra.delegationOrigin as never } : {}),
    });
    await loop.run(text);
    return probe.result;
  }
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;

  it('path A: after a restart, a same-session follow-up overwrites the delivered file on the first Bash call', async () => {
    const deck = path.join(outDir, `deck-${n}.pptx`);
    await runTurn(`做三页演示稿，成品都存到同一目录：${outDir}`, `printf 'first-version' > ${q(deck)}`);
    expect(fs.readFileSync(deck, 'utf8')).toBe('first-version');
    // Restart: in-memory state gone, only the persisted session mode / record remain.
    resetPermissionModeManager();
    probe.infos.length = 0;
    const before = sha(deck);
    const result = await runTurn('把第三页改一下', `printf 'second-version-longer' > ${q(deck)}`);
    expect(result?.success, JSON.stringify(result)).toBe(true);
    expect(probe.infos.some((e) => e.message === APPLIED)).toBe(true);
    expect(fs.readFileSync(deck, 'utf8')).toBe('second-version-longer');
    expect(sha(deck)).not.toBe(before);
  });

  it('path B: a meta (delegated) continuation of the same session overwrites too', async () => {
    const deck = path.join(outDir, `meta-${n}.pptx`);
    await runTurn(`输出目录：${outDir}`, `printf 'v1' > ${q(deck)}`);
    const result = await runTurn('<drafted_task_plan>改第三页</drafted_task_plan>', `printf 'v2-meta-run' > ${q(deck)}`, { isMeta: true });
    expect(result?.success, JSON.stringify(result)).toBe(true);
    expect(probe.infos.some((e) => e.message === APPLIED)).toBe(true);
    expect(fs.readFileSync(deck, 'utf8')).toBe('v2-meta-run');
  });

  it('FB-2337 shape: a resumed overwrite that echoes $? / $# / $$ keeps the output root', async () => {
    const deck = path.join(outDir, `dollar-${n}.pptx`);
    await runTurn(`输出目录：${outDir}`, `printf 'v1' > ${q(deck)}`);
    resetPermissionModeManager();
    probe.infos.length = 0;
    const result = await runTurn('把第 3 页改一下', `printf 'v2-after-dollar-question' > ${q(deck)}; echo "exit=$? n=$# pid=$$ bang=$!"`);
    expect(result?.success, JSON.stringify(result)).toBe(true);
    expect(probe.infos.some((e) => e.message === APPLIED)).toBe(true);
    expect(fs.readFileSync(deck, 'utf8')).toBe('v2-after-dollar-question');
  });

  it('a python heredoc overwrite (the usual pptx edit) keeps the output root', async () => {
    const deck = path.join(outDir, `heredoc-${n}.pptx`);
    await runTurn(`输出目录：${outDir}`, `printf 'v1' > ${q(deck)}`);
    resetPermissionModeManager();
    probe.infos.length = 0;
    const result = await runTurn('把第 3 页改一下', `python3 - <<'PY'\nopen(${JSON.stringify(deck)}, 'w').write('v2-from-heredoc')\nprint("$HOME stays literal")\nPY`);
    expect(result?.success, JSON.stringify(result)).toBe(true);
    expect(probe.infos.some((e) => e.message === APPLIED)).toBe(true);
    expect(fs.readFileSync(deck, 'utf8')).toBe('v2-from-heredoc');
  });

  it.each([
    ['$HOME', 'echo $HOME'],
    ['${X}', 'echo ${X}'],
    ['$(pwd)', 'echo $(pwd)'],
    ['backtick', 'echo `pwd`'],
  ])('%s still gets no output root', async (_name, tail) => {
    const deck = path.join(outDir, `exp-${n}.pptx`);
    await runTurn(`输出目录：${outDir}`, `printf 'v1' > ${q(deck)}`);
    probe.infos.length = 0;
    const result = await runTurn('改一下', `printf 'sneaky' > ${q(deck)}; ${tail}`);
    expect(probe.infos.some((e) => e.message === APPLIED)).toBe(false);
    expect(result?.success === true && !JSON.stringify(result).includes('Operation not permitted') ? 'wrote' : 'blocked').toBe('blocked');
    expect(fs.readFileSync(deck, 'utf8')).toBe('v1');
  });

  it('negative: another session, or a non-full-access mode, gets no write root', async () => {
    const deck = path.join(outDir, `neg-${n}.pptx`);
    await runTurn(`输出目录：${outDir}`, `printf 'v1' > ${q(deck)}`);
    probe.infos.length = 0;
    getPermissionModeManager().setSessionMode(`other-${n}`, 'bypassPermissions', true);
    const other = await runTurn('改一下', `printf 'intruder' > ${q(deck)}`, { sid: `other-${n}` });
    expect(probe.infos.some((e) => e.message === APPLIED)).toBe(false);
    expect(other?.success).toBe(false);
    expect(fs.readFileSync(deck, 'utf8')).toBe('v1');
    getPermissionModeManager().setSessionMode(sessionId, 'default');
    probe.infos.length = 0;
    const down = await runTurn('改一下', `printf 'downgraded' > ${q(deck)}`);
    expect(probe.infos.some((e) => e.message === APPLIED)).toBe(false);
    expect(down?.success).not.toBe(true);
    expect(fs.readFileSync(deck, 'utf8')).toBe('v1');
  });
});
