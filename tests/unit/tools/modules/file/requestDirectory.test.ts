// ============================================================================
// request_directory (native ToolModule) Tests
//
// 核心验证点：授权前工具真的碰不到目标目录——只有 canUseTool 放行之后才会调用
// setFolderTrust/updateProject 做实际授权；deny/未过审批一律不落地任何 grant。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import type { WorkspaceScope } from '../../../../../src/shared/contract/project';
import { canonicalizeWorkspacePath } from '../../../../../src/host/runtime/workspaceScope';

await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePathMod = await import('node:path');
  process.env.CODE_AGENT_DATA_DIR = nodeFs.mkdtempSync(nodePathMod.join(nodeOs.tmpdir(), 'req-dir-data-'));
});

const getProjectDetailMock = vi.fn();
const updateProjectMock = vi.fn();
const setFolderTrustMock = vi.fn();

vi.mock('../../../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({
    getProjectDetail: getProjectDetailMock,
    updateProject: updateProjectMock,
  }),
}));

vi.mock('../../../../../src/host/security/folderTrustService', () => ({
  setFolderTrust: (...args: unknown[]) => setFolderTrustMock(...args),
}));

import { getPermissionModeManager, resetPermissionModeManager } from '../../../../../src/host/permissions/modes';
import { withTaskOutputDirectory } from '../../../../../src/host/permissions/taskOutputDirectory';
import { requestDirectoryModule } from '../../../../../src/host/tools/modules/file/requestDirectory';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'user denied' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn = allowAll,
) {
  const handler = await requestDirectoryModule.createHandler();
  return handler.execute(args, ctx, canUseTool);
}

let primaryDir: string;
let outsideDir: string;
let scope: WorkspaceScope;

beforeEach(() => {
  getProjectDetailMock.mockReset();
  updateProjectMock.mockReset();
  setFolderTrustMock.mockReset();

  primaryDir = canonicalizeWorkspacePath(mkdtempSync(path.join(tmpdir(), 'req-dir-primary-')));
  outsideDir = canonicalizeWorkspacePath(mkdtempSync(path.join(tmpdir(), 'req-dir-outside-')));
  scope = {
    projectId: 'proj_test',
    primaryRoot: primaryDir,
    roots: [{ sourceId: 'src_primary', path: primaryDir, role: 'primary', access: 'read_write' }],
    version: 'v1',
  };
});

afterEach(() => {
  rmSync(primaryDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('requestDirectoryModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(requestDirectoryModule.schema.name).toBe('request_directory');
      expect(requestDirectoryModule.schema.permissionLevel).toBe('write');
      expect(requestDirectoryModule.schema.readOnly).toBe(false);
      expect(requestDirectoryModule.schema.inputSchema.required).toEqual(['path', 'reason']);
    });
  });

  describe('validation & pre-checks', () => {
    it('rejects missing path', async () => {
      const result = await run({ reason: 'need it' }, makeCtx({ workspaceScope: scope }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing reason', async () => {
      const result = await run({ path: outsideDir }, makeCtx({ workspaceScope: scope }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects a directory that does not exist, without asking permission', async () => {
      const askSpy = vi.fn(allowAll);
      const result = await run(
        { path: path.join(outsideDir, 'does-not-exist'), reason: 'x' },
        makeCtx({ workspaceScope: scope }),
        askSpy,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_FOUND');
      expect(askSpy).not.toHaveBeenCalled();
    });

    it('rejects a path that is a file, not a directory', async () => {
      const filePath = path.join(outsideDir, 'file.txt');
      writeFileSync(filePath, 'x');
      const result = await run({ path: filePath, reason: 'x' }, makeCtx({ workspaceScope: scope }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('short-circuits without asking permission when the directory is already in scope', async () => {
      const askSpy = vi.fn(allowAll);
      const result = await run({ path: primaryDir, reason: 'x' }, makeCtx({ workspaceScope: scope }), askSpy);
      expect(result.ok).toBe(true);
      expect(askSpy).not.toHaveBeenCalled();
      expect(setFolderTrustMock).not.toHaveBeenCalled();
      expect(updateProjectMock).not.toHaveBeenCalled();
    });

    it('errors with NO_PROJECT when session has no workspaceScope, without asking permission', async () => {
      const askSpy = vi.fn(allowAll);
      const result = await run({ path: outsideDir, reason: 'x' }, makeCtx({ workspaceScope: undefined }), askSpy);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NO_PROJECT');
      expect(askSpy).not.toHaveBeenCalled();
    });
  });

  describe('permission gate — this is the actual root-admission chokepoint', () => {
    it('denied: does NOT grant access (no folder-trust write, no Project Source update)', async () => {
      const result = await run({ path: outsideDir, reason: 'need it' }, makeCtx({ workspaceScope: scope }), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
      expect(setFolderTrustMock).not.toHaveBeenCalled();
      expect(updateProjectMock).not.toHaveBeenCalled();
    });

    it('approved: grants access via setFolderTrust + updateProject with the requested access level', async () => {
      getProjectDetailMock.mockReturnValue({
        project: { id: 'proj_test', name: 'Test', description: null, sourceRevision: 3 },
        sources: [
          { id: 'src_primary', path: primaryDir, canonicalPath: primaryDir, role: 'primary', access: 'read_write', trustState: 'trusted' },
        ],
      });
      updateProjectMock.mockResolvedValue({ project: { sourceRevision: 4 } });

      const result = await run(
        { path: outsideDir, reason: 'need to read sibling config', access: 'read_write' },
        makeCtx({ workspaceScope: scope }),
        allowAll,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain(outsideDir);
      expect(setFolderTrustMock).toHaveBeenCalledWith(outsideDir, 'trusted', 'request_directory');
      expect(updateProjectMock).toHaveBeenCalledTimes(1);
      const [input] = updateProjectMock.mock.calls[0];
      expect(input.projectId).toBe('proj_test');
      expect(input.revision).toBe(3);
      expect(input.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: outsideDir, role: 'additional', access: 'read_write', trustState: 'trusted' }),
        ]),
      );
    });

    it('defaults to read_only access when not specified', async () => {
      getProjectDetailMock.mockReturnValue({
        project: { id: 'proj_test', name: 'Test', description: null, sourceRevision: 0 },
        sources: [],
      });
      updateProjectMock.mockResolvedValue({ project: { sourceRevision: 1 } });

      await run({ path: outsideDir, reason: 'x' }, makeCtx({ workspaceScope: scope }), allowAll);

      const [input] = updateProjectMock.mock.calls[0];
      expect(input.sources).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: outsideDir, access: 'read_only' })]),
      );
    });

    it('approved but Project not found: fails without throwing', async () => {
      getProjectDetailMock.mockReturnValue(undefined);
      const result = await run({ path: outsideDir, reason: 'x' }, makeCtx({ workspaceScope: scope }), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NO_PROJECT');
      expect(updateProjectMock).not.toHaveBeenCalled();
    });

    it('approved but updateProject rejects (revision race): surfaces a clean error', async () => {
      getProjectDetailMock.mockReturnValue({
        project: { id: 'proj_test', name: 'Test', description: null, sourceRevision: 3 },
        sources: [],
      });
      updateProjectMock.mockRejectedValue(new Error('Project Sources changed; expected revision 3.'));
      const result = await run({ path: outsideDir, reason: 'x' }, makeCtx({ workspaceScope: scope }), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('GRANT_FAILED');
        expect(result.error).toContain('expected revision 3');
      }
    });
  });
});

// 完全访问 + 走开：交接出去的后台/辅助执行继承任务输出目录，对已授权目录 request_directory
// 不能再停车等「需要授权」，否则走开的用户永远收不到成品。
describe('request_directory inside the task output directory lease', () => {
  const SESSION = 'req-dir-bypass-session';
  const asked = vi.fn(async () => ({ allow: true }) as const);

  beforeEach(() => {
    asked.mockClear();
    resetPermissionModeManager();
    getPermissionModeManager().setSessionMode(SESSION, 'bypassPermissions', true, 'user-ui');
  });
  afterEach(() => resetPermissionModeManager());

  const lease = <T,>(dir: string, fn: () => Promise<T>, inherit = false) => withTaskOutputDirectory({
    sessionId: SESSION, internal: false, inherit, userText: `做两份成品，成品都存到同一目录：${dir}`,
  }, fn);

  it('bypass session: the granted directory resolves without asking anyone', async () => {
    const result = await lease(outsideDir, () => run(
      { path: outsideDir, reason: '写成品', access: 'read_write' }, makeCtx({ sessionId: SESSION, workspaceScope: scope }), asked));
    expect(result.ok).toBe(true);
    expect(asked).not.toHaveBeenCalled();
    expect(updateProjectMock).not.toHaveBeenCalled();
  });

  it('auxiliary run inheriting the lease resolves without asking too', async () => {
    const result = await lease(outsideDir, () => lease(outsideDir, () => run(
      { path: outsideDir, reason: '写成品', access: 'read_write' }, makeCtx({ sessionId: SESSION, workspaceScope: scope }), asked), true));
    expect(result.ok).toBe(true);
    expect(asked).not.toHaveBeenCalled();
  });

  it('a different directory, an expired lease and a non-bypass session still ask', async () => {
    const other = canonicalizeWorkspacePath(mkdtempSync(path.join(tmpdir(), 'req-dir-other-')));
    getProjectDetailMock.mockReturnValue({ project: { name: 'p', sourceRevision: 0 }, sources: [] });
    updateProjectMock.mockResolvedValue(true);
    try {
      await lease(outsideDir, () => run({ path: other, reason: 'x' }, makeCtx({ sessionId: SESSION, workspaceScope: scope }), asked));
      expect(asked).toHaveBeenCalledTimes(1);
      await run({ path: outsideDir, reason: 'x', access: 'read_write' }, makeCtx({ sessionId: SESSION, workspaceScope: scope }), asked);
      expect(asked).toHaveBeenCalledTimes(2);
      getPermissionModeManager().setSessionMode(SESSION, 'default', false, 'user-ui');
      await lease(outsideDir, () => run({ path: outsideDir, reason: 'x', access: 'read_write' }, makeCtx({ sessionId: SESSION, workspaceScope: scope }), asked));
      expect(asked).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
