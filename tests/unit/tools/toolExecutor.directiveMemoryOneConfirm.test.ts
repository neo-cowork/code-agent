import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

const mocks = vi.hoisted(() => ({
  confirmation: vi.fn(),
  execute: vi.fn(),
  getSchemas: vi.fn(),
  has: vi.fn(),
  loggerWarn: vi.fn(),
  resolve: vi.fn(),
  hasInteractiveUi: vi.fn(() => true),
}));

vi.mock('../../../src/host/memory/directiveMemoryConfirmation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/memory/directiveMemoryConfirmation')>(),
  requestDirectiveMemoryConfirmation: mocks.confirmation,
}));

vi.mock('../../../src/host/platform/windowBridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/platform/windowBridge')>(),
  hasInteractiveUi: mocks.hasInteractiveUi,
}));

vi.mock('../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: () => ({
    getSchemas: mocks.getSchemas,
    has: mocks.has,
    resolve: mocks.resolve,
  }),
  isProtocolToolName: vi.fn(() => false),
  resetProtocolRegistry: vi.fn(),
}));

vi.mock('../../../src/host/tools/protocolToolRegistration', () => ({
  getProtocolToolSchemas: mocks.getSchemas,
  hasProtocolTool: mocks.has,
  resolveProtocolTool: mocks.resolve,
  registerProtocolTool: vi.fn(),
  unregisterProtocolTool: vi.fn(),
  setProtocolToolRegistryPort: vi.fn(),
}));

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getAllToolMeta: () => ({}) }),
}));

vi.mock('../../../src/host/mcp', () => ({
  getMCPClient: () => ({
    getToolDefinitions: () => [],
    parseMCPToolName: () => null,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
    invalidateForPath: vi.fn(),
    invalidateForWorkspace: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.loggerWarn, error: vi.fn() }),
}));

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { resetToolResolver } = await import('../../../src/host/tools/dispatch/toolResolver');
const { getDecisionHistory } = await import('../../../src/host/security/decisionHistory');

const { createRunContext } = await import('../../../src/host/runtime/runContext');
const { createWorkspaceScope } = await import('../../../src/host/runtime/workspaceScope');

const schemas = [{
  name: 'Write',
  description: 'write file',
  inputSchema: {
    type: 'object',
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'],
  },
  category: 'fs',
  permissionLevel: 'write',
  pathAuthority: [{ kind: 'path', pathParameter: 'file_path' }],
}, {
  name: 'Edit',
  description: 'edit file',
  inputSchema: {
    type: 'object',
    properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
    required: ['file_path', 'old_string', 'new_string'],
  },
  category: 'fs',
  permissionLevel: 'write',
  pathAuthority: [{ kind: 'path', pathParameter: 'file_path', mutation: 'edit' }],
}] as const;

// 记忆目录必须在 tmpdir 之外：tmpdir 本身是分类器的写入白名单，放里面测不出 W3。
describe('directive memory write: one confirmation, no outside-project card', () => {
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
  let root: string;
  let workspace: string;
  let memoryDir: string;
  let otherOutside: string;
  const permission = vi.fn(async () => true);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.homedir(), '.neo-memconfirm-test-'));
    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neo-memconfirm-ws-')));
    memoryDir = path.join(root, 'memory');
    otherOutside = path.join(root, 'other');
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(otherOutside, { recursive: true });
    process.env.CODE_AGENT_DATA_DIR = root;
    resetToolResolver();
    mocks.getSchemas.mockReturnValue(schemas);
    mocks.has.mockReturnValue(true);
    mocks.resolve.mockResolvedValue({
      execute: mocks.execute.mockImplementation(async (params: { file_path: string; content: string }) => {
        await fs.writeFile(params.file_path, params.content);
        return { ok: true, output: 'written' };
      }),
    });
    mocks.confirmation.mockReset();
    mocks.hasInteractiveUi.mockReset().mockReturnValue(true);
    permission.mockClear();
    getDecisionHistory().clear();
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const confirm = (confirmed: boolean) => mocks.confirmation.mockResolvedValueOnce({
    requestId: 'dir-1', confirmed, respondedAt: Date.now(), timedOut: false,
  });

  let runSeq = 0;
  function buildExecutor(runId = `mc-run-${++runSeq}`) {
    const executor = new ToolExecutor({
      requestPermission: permission,
      workingDirectory: workspace,
      runContext: createRunContext({
        runId, sessionId: 'mc-session', cwd: workspace,
        workspaceScope: createWorkspaceScope('mc-project', [{
          sourceId: 'ws-root', path: workspace, access: 'read_write', role: 'primary',
        }]),
      }),
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  const write = (file: string) => buildExecutor().execute(
    'Write', { file_path: file, content: 'rule' }, { sessionId: 'mc-session' },
  );

  it('confirmed rule dialog: written, no permission card, trace carries the new rule', async () => {
    const target = path.join(memoryDir, 'weekly.md');
    confirm(true);
    const result = await write(target);
    expect(result).toMatchObject({ success: true });
    expect(existsSync(target)).toBe(true);
    expect(permission).not.toHaveBeenCalled();
    const rows = JSON.stringify(getDecisionHistory().getAll());
    expect(rows).toContain('directive_memory_write_confirmed');
    expect(rows).not.toContain('W3: outside_project');
  });

  it('declined dialog: nothing written, no card', async () => {
    const target = path.join(memoryDir, 'declined.md');
    confirm(false);
    const result = await write(target);
    expect(result).toMatchObject({ success: false, metadata: { code: 'DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED' } });
    expect(existsSync(target)).toBe(false);
    expect(permission).not.toHaveBeenCalled();
  });

  it('other outside-workspace path still asks', async () => {
    const target = path.join(otherOutside, 'note.md');
    const result = await write(target);
    expect(result).toMatchObject({ success: true });
    expect(mocks.confirmation).not.toHaveBeenCalled();
    expect(permission).toHaveBeenCalledOnce();
    expect(JSON.stringify(permission.mock.calls[0])).toContain('写入项目目录外');
  });

  it('../ escape out of the memory dir still asks', async () => {
    const target = path.join(memoryDir, '..', 'other', 'esc.md');
    const result = await write(target);
    expect(result).toMatchObject({ success: true });
    expect(mocks.confirmation).not.toHaveBeenCalled();
    expect(permission).toHaveBeenCalledOnce();
  });

  it('symlink inside the memory dir pointing out still asks', async () => {
    await fs.symlink(path.join(otherOutside, 'real.md'), path.join(memoryDir, 'link.md'));
    confirm(true);
    await write(path.join(memoryDir, 'link.md'));
    expect(permission).toHaveBeenCalledOnce();
    expect(JSON.stringify(permission.mock.calls[0])).toContain('写入项目目录外');
  });

  it('rule file + INDEX.md pointer in one run: one dialog, no card, both written', async () => {
    const executor = buildExecutor();
    const rule = path.join(memoryDir, 'weekly-report-format.md');
    const index = path.join(memoryDir, 'INDEX.md');
    confirm(true);
    const r1 = await executor.execute('Write', { file_path: rule, content: 'rule' }, { sessionId: 'mc-session' });
    const r2 = await executor.execute('Write',
      { file_path: index, content: '- [周报格式](weekly-report-format.md)' }, { sessionId: 'mc-session' });
    expect(r1).toMatchObject({ success: true });
    expect(r2).toMatchObject({ success: true });
    expect(mocks.confirmation).toHaveBeenCalledOnce();
    expect(permission).not.toHaveBeenCalled();
    expect(existsSync(rule)).toBe(true);
    expect(existsSync(index)).toBe(true);
  });

  it('lone INDEX.md write with no confirmed rule in this run still asks', async () => {
    confirm(true);
    await buildExecutor().execute('Write',
      { file_path: path.join(memoryDir, 'INDEX.md'), content: '- weekly-report-format.md' }, { sessionId: 'mc-session' });
    expect(mocks.confirmation).toHaveBeenCalledOnce();
  });

  it('INDEX.md in another run is not covered by an earlier run\'s confirmation', async () => {
    confirm(true);
    await buildExecutor().execute('Write',
      { file_path: path.join(memoryDir, 'weekly-report-format.md'), content: 'rule' }, { sessionId: 'mc-session' });
    confirm(true);
    await buildExecutor().execute('Write',
      { file_path: path.join(memoryDir, 'INDEX.md'), content: '- weekly-report-format.md' }, { sessionId: 'mc-session' });
    expect(mocks.confirmation).toHaveBeenCalledTimes(2);
  });

  it('declined rule: INDEX.md afterwards still asks and nothing is written', async () => {
    const executor = buildExecutor();
    confirm(false);
    await executor.execute('Write', { file_path: path.join(memoryDir, 'r.md'), content: 'rule' }, { sessionId: 'mc-session' });
    confirm(false);
    const r = await executor.execute('Write',
      { file_path: path.join(memoryDir, 'INDEX.md'), content: '- r.md' }, { sessionId: 'mc-session' });
    expect(r).toMatchObject({ success: false, metadata: { code: 'DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED' } });
    expect(mocks.confirmation).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(memoryDir, 'INDEX.md'))).toBe(false);
  });

  it.each([
    ['memory.md', 'unrelated pointer text'],
    ['code.md', '- [x](xcode.md) and code.md.bak'],
  ])('INDEX.md body that does not really name the confirmed rule %s still asks', async (ruleName, body) => {
    const executor = buildExecutor();
    confirm(true);
    await executor.execute('Write', { file_path: path.join(memoryDir, ruleName), content: 'rule' }, { sessionId: 'mc-session' });
    confirm(false);
    const r = await executor.execute('Write',
      { file_path: path.join(memoryDir, 'INDEX.md'), content: body }, { sessionId: 'mc-session' });
    expect(mocks.confirmation).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ success: false, metadata: { code: 'DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED' } });
    expect(existsSync(path.join(memoryDir, 'INDEX.md'))).toBe(false);
  });

  it('non-normalized INDEX.md path (memory.md/../INDEX.md) is never covered by the earlier confirmation', async () => {
    const executor = buildExecutor();
    confirm(true);
    await executor.execute('Write', { file_path: path.join(memoryDir, 'memory.md'), content: 'rule' }, { sessionId: 'mc-session' });
    confirm(false);
    const r = await executor.execute('Write',
      { file_path: `${memoryDir}/memory.md/../INDEX.md`, content: 'memory.md is the pointer' }, { sessionId: 'mc-session' });
    expect(mocks.confirmation).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ success: false, metadata: { code: 'DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED' } });
    expect(existsSync(path.join(memoryDir, 'INDEX.md'))).toBe(false);
  });

  it('Edit of INDEX.md whose old_string (not new_string) names the confirmed rule still asks', async () => {
    const executor = buildExecutor();
    confirm(true);
    await executor.execute('Write', { file_path: path.join(memoryDir, 'weekly.md'), content: 'rule' }, { sessionId: 'mc-session' });
    confirm(false);
    const r = await executor.execute('Edit',
      { file_path: path.join(memoryDir, 'INDEX.md'), old_string: '- weekly.md', new_string: '- something else' }, { sessionId: 'mc-session' });
    expect(mocks.confirmation).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ success: false, metadata: { code: 'DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED' } });
  });
});
