import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 模型输出的路径键 / command 带首尾空白：授权判定（写围栏 / 审批）与实际打开必须是同一个文件。
// 走真 ToolExecutor.execute（含 PTC 嵌套再入口）；用户手打命令（!run 同路径）command 逐字节。

const resolverState = vi.hoisted(() => ({ getDefinition: vi.fn(), execute: vi.fn() }));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { ToolContext } from '../../../src/host/tools/types';
import { resolveToolPath } from '../../../src/host/tools/writeTargets';
import { createRunContext } from '../../../src/host/runtime/runContext';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import { getDenialRegistry } from '../../../src/host/security/denialRegistry';

const WORKDIR = '/tmp/workbench';
const SSH_PADDED = '\n/Users/x/.ssh/config ';
const SSH_CLEAN = '/Users/x/.ssh/config';

const defs: Record<string, Record<string, unknown>> = {
  Write: { name: 'Write', description: 'w', inputSchema: { type: 'object', properties: {}, required: [] }, requiresPermission: true, permissionLevel: 'write' },
  Bash: { name: 'Bash', description: 'b', inputSchema: { type: 'object', properties: {}, required: [] }, requiresPermission: true, permissionLevel: 'execute' },
  workflow: { name: 'workflow', description: 'wf', inputSchema: { type: 'object', properties: {}, required: [] }, requiresPermission: false, permissionLevel: 'execute' },
};

function makeExecutor(requestPermission = vi.fn().mockResolvedValue(true)) {
  const executor = new ToolExecutor({
    requestPermission,
    workingDirectory: WORKDIR,
    permissionModeOverride: 'readOnly',
  });
  return { executor, requestPermission };
}

describe('ToolExecutor 标识类参数规范化', () => {
  beforeEach(() => {
    getDenialRegistry().clearAll();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) => defs[name]);
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
  });

  it('PTC 嵌套 tools.Write 带空白路径：审批看到的与实际打开的是同一个规范路径', async () => {
    const contexts: ToolContext[] = [];
    resolverState.execute.mockImplementation(async (_n: string, _p: unknown, ctx: ToolContext) => {
      contexts.push(ctx);
      return { success: true, output: 'ok' };
    });
    const { executor, requestPermission } = makeExecutor();
    await executor.execute('workflow', { script: 'noop' }, { sessionId: 's1' });

    await contexts[0].executeTool!('Write', { file_path: SSH_PADDED, content: '  body\n' });

    const opened = resolverState.execute.mock.calls.find((c) => c[0] === 'Write')![1] as Record<string, unknown>;
    expect(opened.file_path).toBe(SSH_CLEAN);
    expect(opened.content).toBe('  body\n');
    expect(resolveToolPath(String(opened.file_path), WORKDIR)).toBe(resolveToolPath(SSH_CLEAN, WORKDIR));
    expect(requestPermission).toHaveBeenCalled();
    const asked = JSON.stringify(requestPermission.mock.calls.map((c) => c[0]));
    expect(asked).toContain(SSH_CLEAN);
    expect(asked).not.toContain('\\n/Users/x');
  });

  it('直接 execute(Write) 带空白路径：同样裁成同一个路径再判定和执行', async () => {
    const { executor, requestPermission } = makeExecutor();
    await executor.execute('Write', { file_path: SSH_PADDED, content: 'x' }, { sessionId: 's1' });
    const opened = resolverState.execute.mock.calls[0][1] as Record<string, unknown>;
    expect(opened.file_path).toBe(SSH_CLEAN);
    const asked = JSON.stringify(requestPermission.mock.calls.map((c) => c[0]));
    expect(asked).toContain(SSH_CLEAN);
    expect(asked).not.toContain('\\n/Users/x');
  });

  it('直接 execute(Bash) 的 command 逐字节保留（!run 用户手打命令）', async () => {
    const { executor } = makeExecutor();
    await executor.execute('Bash', { command: 'x ' }, { sessionId: 's1' });
    expect((resolverState.execute.mock.calls[0][1] as Record<string, unknown>).command).toBe('x ');
  });

  it('PTC 嵌套 tools.Bash 的 command（模型写的代码）会被裁', async () => {
    const contexts: ToolContext[] = [];
    resolverState.execute.mockImplementation(async (_n: string, _p: unknown, ctx: ToolContext) => {
      contexts.push(ctx);
      return { success: true, output: 'ok' };
    });
    const { executor } = makeExecutor();
    await executor.execute('workflow', { script: 'noop' }, { sessionId: 's1' });
    await contexts[0].executeTool!('Bash', { command: '  ls\n' });
    const bash = resolverState.execute.mock.calls.find((c) => c[0] === 'Bash')![1] as Record<string, unknown>;
    expect(bash.command).toBe('ls');
  });

  describe('run workspace boundary sees the trimmed working_directory', () => {
    let root: string;
    beforeEach(async () => {
      root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'padded-wd-')));
      // ws/link → 工作区外。旧顺序下 'link ' 不存在、能过边界检查，裁剪后才变成指向外部的 symlink
      await fs.mkdir(path.join(root, 'ws', 'sub'), { recursive: true });
      await fs.mkdir(path.join(root, 'outside'), { recursive: true });
      await fs.symlink(path.join(root, 'outside'), path.join(root, 'ws', 'link'), 'dir');
    });
    afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

    function runExecutor() {
      const workspace = path.join(root, 'ws');
      const run = createRunContext({
        runId: 'run-padded-wd',
        sessionId: 'session-padded-wd',
        workspaceScope: createWorkspaceScope('project-padded-wd', [{
          sourceId: 'primary-padded-wd', path: workspace, role: 'primary', access: 'read_write',
        }]),
      });
      const executor = new ToolExecutor({
        requestPermission: async () => true,
        workingDirectory: root,
      }).forRun(run);
      return { workspace, executor, options: { runId: run.runId, sessionId: run.sessionId, preApprovedTools: new Set(['Bash']) } };
    }

    it("working_directory '<ws>/link ' (link -> outside) is rejected, not trimmed into the symlink after the check", async () => {
      const { workspace, executor, options } = runExecutor();
      const result = await executor.execute('Bash', { command: 'pwd', working_directory: `${workspace}/link ` }, options);
      expect(result).toMatchObject({ success: false, metadata: { code: 'RUN_WORKSPACE_BOUNDARY' } });
      expect(resolverState.execute).not.toHaveBeenCalled();
    });

    it("working_directory ' <ws>/sub\n' reaches the resolver as '<ws>/sub'", async () => {
      const { workspace, executor, options } = runExecutor();
      await executor.execute('Bash', { command: 'pwd', working_directory: ` ${workspace}/sub\n` }, options);
      const params = resolverState.execute.mock.calls[0][1] as Record<string, unknown>;
      expect(params.working_directory).toBe(path.join(workspace, 'sub'));
    });
  });
});
