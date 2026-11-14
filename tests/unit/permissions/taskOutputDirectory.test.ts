import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPermissionModeManager, resetPermissionModeManager, type PermissionMode } from '../../../src/host/permissions/modes';
import { isTaskOutputPathAuthorized, taskOutputDirectoryForShell, withTaskOutputDirectory } from '../../../src/host/permissions/taskOutputDirectory';
import { PermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { resolveToolPermissionClassification } from '../../../src/host/tools/toolPermissionClassification';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import type { MessageMetadata } from '../../../src/shared/contract';

const SESSION = 'task-output-session';
let directory: string;
const authorized = (target = path.join(directory, 'minutes.md'), mode: PermissionMode = 'bypassPermissions', sessionId = SESSION) =>
  isTaskOutputPathAuthorized({ sessionId, mode, target, cwd: directory });
const task = (userText: string, run: () => Promise<void>, metadata?: MessageMetadata, internal = false) =>
  withTaskOutputDirectory({ sessionId: SESSION, userText, metadata, internal }, run);

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-output-')));
  resetPermissionModeManager();
  getPermissionModeManager().setSessionMode(SESSION, 'bypassPermissions', true);
});
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); resetPermissionModeManager(); });

describe('explicit task output directory authorization', () => {
  it('covers only the named directory, current session and full-access mode', async () => {
    await task(`请处理表格，成品都存到同一目录：${directory}/`, async () => {
      expect(authorized()).toBe(true);
      expect(authorized(path.join(directory, 'slides', 'report.pptx'))).toBe(true);
      expect(authorized(`${directory}-sibling/minutes.md`)).toBe(false);
      expect(authorized(path.join(directory, '..', 'escape.md'))).toBe(false);
      expect(authorized(undefined, 'default')).toBe(false);
      expect(authorized(undefined, 'readOnly')).toBe(false);
      expect(authorized(undefined, 'bypassPermissions', 'other-session')).toBe(false);
      expect(authorized(path.join(directory, '.git', 'config'))).toBe(false);
    });
    expect(authorized()).toBe(false);
  });

  it('expires in detached async descendants after task completion', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let detached!: Promise<boolean>;
    await task(`输出目录：${directory}`, async () => {
      expect(authorized()).toBe(true);
      detached = waiting.then(() => authorized());
    });
    release();
    expect(await detached).toBe(false);
  });

  it('expires after failure and is not inherited by a new task', async () => {
    await expect(task(`输出目录：${directory}`, async () => { throw new Error('task failed'); })).rejects.toThrow('task failed');
    await task('继续处理会议纪要', async () => { expect(authorized()).toBe(false); });
  });

  it.each([
    '资料里提到 PATH',
    '不要写入，输出目录：PATH',
    '> 输出目录：PATH',
    '```text\n输出目录：PATH\n```',
    '输出目录："PATH"',
    '输出目录：PATH/../other',
    '输出目录：PATH\n输出目录：PATH/other',
    '输出目录：relative/deliver',
    '输出目录：/',
  ])('does not infer consent from a mention or ambiguous instruction: %s', async (prompt) => {
    await task(prompt.replaceAll('PATH', directory), async () => { expect(authorized()).toBe(false); });
  });

  it.each([
    { automation: { automationType: 'role_wake' } },
    { telemetryRecovered: true },
    { runtimeSteer: true },
    { agentTeam: {} },
    { channel: {} },
  ])('does not mint from automated, recovered or relayed input: %j', async (metadata) => {
    await task(`输出目录：${directory}`, async () => { expect(authorized()).toBe(false); }, metadata as MessageMetadata);
  });

  it('does not mint for internal tasks or tasks started outside full access', async () => {
    await task(`输出目录：${directory}`, async () => { expect(authorized()).toBe(false); }, undefined, true);
    getPermissionModeManager().setSessionMode(SESSION, 'default');
    await task(`输出目录：${directory}`, async () => { expect(authorized()).toBe(false); });
  });

  it('shares the grant with an already-started auxiliary task until all task executions end', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let child!: Promise<void>;
    let late!: Promise<boolean>;
    let releaseLate!: () => void;
    const lateWaiting = new Promise<void>((resolve) => { releaseLate = resolve; });
    await task(`输出目录：${directory}`, async () => {
      child = withTaskOutputDirectory({ sessionId: SESSION, userText: 'delegated work', internal: true, inherit: true }, async () => {
        await waiting;
        expect(authorized()).toBe(true);
        late = lateWaiting.then(() => authorized());
      });
    });
    release(); await child;
    releaseLate(); expect(await late).toBe(false);
  });

  it('adds only the selected directory to plain shell commands, retaining substitution and mode boundaries', async () => {
    expect(taskOutputDirectoryForShell(SESSION, 'bypassPermissions', 'cp report.pptx output.pptx')).toBeUndefined();
    await task(`输出目录：${directory}`, async () => {
      expect(taskOutputDirectoryForShell(SESSION, 'bypassPermissions', 'cp report.pptx output.pptx')).toBe(directory);
      expect(taskOutputDirectoryForShell(SESSION, 'default', 'cp report.pptx output.pptx')).toBeUndefined();
      expect(taskOutputDirectoryForShell('other-session', 'bypassPermissions', 'cp report.pptx output.pptx')).toBeUndefined();
      expect(taskOutputDirectoryForShell(SESSION, 'bypassPermissions', 'cp report.pptx "$(pwd)/output.pptx"')).toBeUndefined();
      expect(taskOutputDirectoryForShell(SESSION, 'bypassPermissions', 'cp report.pptx `pwd`/output.pptx')).toBeUndefined();
      const primary = { sourceId: 'primary', role: 'primary' as const, access: 'read_write' as const, path: `${directory}-workspace` };
      const scope = createWorkspaceScope('project', [primary, { sourceId: 'readonly', role: 'additional', access: 'read_only', path: directory }]);
      expect(taskOutputDirectoryForShell(SESSION, 'bypassPermissions', 'cp report.pptx output.pptx', scope)).toBeUndefined();
      const childScope = createWorkspaceScope('project', [primary, { sourceId: 'readonly', role: 'additional', access: 'read_only', path: path.join(directory, 'source') }]);
      expect(taskOutputDirectoryForShell(SESSION, 'bypassPermissions', 'cp report.pptx output.pptx', childScope)).toBeUndefined();
    });
  });

  it('never caches a task grant into the next task or a concurrent ungranted scope', async () => {
    const virtualRoot = path.join(path.parse(directory).root, `neo-output-${path.basename(directory)}`);
    const classifier = new PermissionClassifier({ enableLlm: false });
    const args = { file_path: path.join(virtualRoot, 'minutes.md'), content: '# minutes' };
    const context = { sessionId: SESSION, permissionMode: 'bypassPermissions' as const, workingDirectory: directory, workspaceRoot: directory };
    await task(`输出目录：${virtualRoot}`, async () => {
      expect(await classifier.classify('Write', args, context)).toMatchObject({ decision: 'approve', bypassCache: true });
      await task('请整理会议纪要', async () => {
        expect(await classifier.classify('Write', args, context)).toMatchObject({ decision: 'ask', trustBoundary: true });
      });
      expect(await classifier.classify('Write', args, context)).toMatchObject({ decision: 'approve', bypassCache: true });
    });
    expect(await classifier.classify('Write', args, context)).toMatchObject({ decision: 'ask', trustBoundary: true, cached: false });
  });

  it('rejects symlink escapes and root retargets while retaining the frozen directory', async () => {
    const inside = path.join(directory, 'original');
    const elsewhere = path.join(directory, 'elsewhere');
    const link = path.join(directory, 'selected');
    fs.mkdirSync(inside); fs.mkdirSync(elsewhere); fs.symlinkSync(inside, link);
    await task(`输出目录：${link}`, async () => {
      expect(authorized(path.join(link, 'minutes.md'))).toBe(true);
      const escape = path.join(inside, 'escape');
      fs.symlinkSync(elsewhere, escape);
      expect(authorized(path.join(escape, 'minutes.md'))).toBe(false);
      fs.unlinkSync(link); fs.symlinkSync(elsewhere, link);
      expect(authorized(path.join(link, 'minutes.md'))).toBe(false);
      expect(authorized(path.join(inside, 'minutes.md'))).toBe(false);
    });
  });

  it.each([
    { tool: 'Bash', params: { command: 'git push origin main' }, level: 'execute', mode: 'bypassPermissions' },
    { tool: 'Bash', params: { command: './bash -c "echo ok"' }, level: 'execute', mode: 'bypassPermissions' },
    { tool: 'Bash', params: { command: 'cat ~/.aws/credentials' }, level: 'execute', mode: 'bypassPermissions' },
    { tool: 'mail_send', params: {}, level: 'write', mode: 'bypassPermissions' },
    { tool: 'Write', params: { content: '# notes' }, level: 'write', mode: 'acceptEdits' },
  ] as const)('preserves baseline auto-approval for $mode $tool $params', async ({ tool, params, level, mode }) => {
    // A virtual non-temp destination exercises the real outside-workspace rule without writing there.
    const virtualRoot = path.join(path.parse(directory).root, `neo-outside-${path.basename(directory)}`);
    const args = tool === 'Write' ? { ...params, file_path: path.join(virtualRoot, 'notes.md') } : params;
    expect(await new PermissionClassifier().classify(tool, args, {
      sessionId: SESSION, workingDirectory: directory, workspaceRoot: directory, permissionLevel: level,
    })).toMatchObject({ decision: 'ask', trustBoundary: true });
    expect(await resolveToolPermissionClassification({
      sessionId: SESSION,
      policyForcesConfirmation: false,
      boundaryViolation: undefined,
      workingDirectory: directory,
      workspaceRoot: directory,
      permStartTime: Date.now(),
      readOnlyForcesConfirmation: false,
      executionToolName: tool, policyToolName: tool,
      params: args, permissionLevel: level, sessionPermissionMode: mode,
    })).toMatchObject({
      decision: 'approve',
      traceStep: { rule: 'permission_mode_auto_approve', result: 'allow' },
    });
  });

  it('retains default-mode boundary asks and acceptEdits external-write confirmation', async () => {
    const base = {
      sessionId: SESSION, policyForcesConfirmation: false, boundaryViolation: undefined,
      workingDirectory: directory, workspaceRoot: directory, permStartTime: Date.now(),
      readOnlyForcesConfirmation: false,
    };
    expect(await resolveToolPermissionClassification({
      ...base, executionToolName: 'Bash', policyToolName: 'Bash',
      params: { command: 'git push origin main' }, permissionLevel: 'execute', sessionPermissionMode: 'default',
    })).toMatchObject({ decision: 'ask', trustBoundary: true });
    expect(await resolveToolPermissionClassification({
      ...base, executionToolName: 'mail_send', policyToolName: 'mail_send',
      params: {}, permissionLevel: 'write', sessionPermissionMode: 'acceptEdits',
    })).toMatchObject({ decision: 'ask', trustBoundary: true });
  });
});
