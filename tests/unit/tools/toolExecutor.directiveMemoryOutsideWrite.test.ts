// 全局记忆 Write：确认过的、且规范路径仍在记忆目录内的这一次调用，不再弹「写入项目目录外」。
// 目录外的其它路径、`..`、以及离开目录的符号链接仍然弹卡。拒绝确认在分类器之前返回。
// 断言走 ToolExecutor.execute 和真实 Write，不替换 protocol resolver。

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirmation: vi.fn(),
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

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { isProtectedWritePath } from '../../../src/host/sandbox/sensitivePaths';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getPermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';

const OUT_PARENT = '/Users/leo/work/out/N-FIX-GLOBAL-MEMORY-WRITE-DOUBLE-CONFIRM-REDESIGN';

function memoryBody(description: string): string {
  return [
    '---',
    'name: weekly',
    `description: ${description}`,
    'type: feedback',
    '---',
    '本周进展 / 风险 / 下周计划',
    '',
  ].join('\n');
}

describe('ToolExecutor 记忆目录写入不再二次审批', () => {
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
  let root = '';
  let workspace = '';
  let dataDir = '';
  let memoryDir = '';
  let permissionRequests: PermissionRequestData[];
  let confirm = true;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    await fs.mkdir(OUT_PARENT, { recursive: true });
    root = await fs.mkdtemp(path.join(OUT_PARENT, 'unit-'));
    workspace = path.join(root, 'project');
    dataDir = path.join(root, 'data');
    memoryDir = path.join(dataDir, 'memory');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(memoryDir, { recursive: true });
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    isProtectedWritePath.resetCacheForTest();
    getToolCache().clear();
    getPermissionClassifier().clearCache();
    resetPermissionModeManager();
    permissionRequests = [];
    confirm = true;
    mocks.hasInteractiveUi.mockReset().mockReturnValue(true);
    mocks.confirmation.mockReset().mockImplementation(async () => ({
      requestId: `directive-test-${mocks.confirmation.mock.calls.length}`,
      confirmed: confirm,
      respondedAt: Date.now(),
      timedOut: false,
    }));
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    isProtectedWritePath.resetCacheForTest();
    getPermissionClassifier().clearCache();
    resetPermissionModeManager();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  function executor(): ToolExecutor {
    const instance = new ToolExecutor({
      workingDirectory: workspace,
      permissionModeOverride: 'default',
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return false;
      },
    });
    instance.setAuditEnabled(false);
    return instance;
  }

  function run(filePath: string, content: string, sessionId: string) {
    return executor().execute('Write', { file_path: filePath, content }, {
      sessionId,
      agentId: 'primary',
    });
  }

  it('确认后的记忆目录 Write 只问一次规则，不弹项目外卡，并写入索引指针', async () => {
    const target = path.join(memoryDir, 'weekly.md');
    const result = await run(target, memoryBody('周报三段式'), 'mem-grant');

    expect(result.success, result.error).toBe(true);
    expect(mocks.confirmation).toHaveBeenCalledTimes(1);
    expect(permissionRequests).toHaveLength(0);
    expect(await fs.readFile(target, 'utf8')).toBe(memoryBody('周报三段式'));
    const index = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf8');
    expect(index).toContain('- [weekly.md](weekly.md) — 周报三段式');
  });

  it('同一次运行里的第二次记忆写入仍要自己的确认', async () => {
    const first = path.join(memoryDir, 'weekly.md');
    const second = path.join(memoryDir, 'numbers.md');
    const firstResult = await run(first, memoryBody('周报三段式'), 'mem-second-a');
    const secondResult = await run(second, memoryBody('数字用万'), 'mem-second-b');

    expect(firstResult.success, firstResult.error).toBe(true);
    expect(secondResult.success, secondResult.error).toBe(true);
    expect(mocks.confirmation).toHaveBeenCalledTimes(2);
    expect(permissionRequests).toHaveLength(0);
    const index = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf8');
    expect(index).toContain('- [weekly.md](weekly.md) — 周报三段式');
    expect(index).toContain('- [numbers.md](numbers.md) — 数字用万');
  });

  it('非记忆目录的项目外路径仍然弹写入项目外卡', async () => {
    const target = path.join(root, 'outside', 'note.md');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const result = await run(target, 'outside\n', 'mem-outside');

    expect(mocks.confirmation).not.toHaveBeenCalled();
    expect(permissionRequests.length, JSON.stringify(permissionRequests)).toBeGreaterThan(0);
    expect(JSON.stringify(permissionRequests)).toContain('W3: outside_project');
    expect(result.success).toBe(false);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('记忆目录上一级的 .. 路径不豁免', async () => {
    const target = `${memoryDir}/../x.md`;
    const result = await run(target, 'escape\n', 'mem-dotdot');

    expect(permissionRequests.length, JSON.stringify(permissionRequests)).toBeGreaterThan(0);
    expect(JSON.stringify(permissionRequests)).toContain('W3: outside_project');
    expect(result.success).toBe(false);
    await expect(fs.access(path.join(dataDir, 'x.md'))).rejects.toThrow();
  });

  it('离开记忆目录的符号链接不豁免', async () => {
    const outsideDir = path.join(root, 'outside');
    await fs.mkdir(outsideDir, { recursive: true });
    const escaped = path.join(outsideDir, 'escaped.md');
    const link = path.join(memoryDir, 'escape.md');
    await fs.symlink(escaped, link);
    const result = await run(link, memoryBody('不应落盘'), 'mem-symlink');

    expect(permissionRequests.length, JSON.stringify(permissionRequests)).toBeGreaterThan(0);
    expect(JSON.stringify(permissionRequests)).toContain('W3: outside_project');
    expect(result.success).toBe(false);
    await expect(fs.access(escaped)).rejects.toThrow();
  });

  it('拒绝确认后不写文件、不弹审批卡、不改索引', async () => {
    confirm = false;
    const indexPath = path.join(memoryDir, 'INDEX.md');
    const originalIndex = '# Memory Index\n\n- [old.md](old.md) — old\n';
    await fs.writeFile(indexPath, originalIndex, 'utf8');
    const target = path.join(memoryDir, 'weekly.md');
    const result = await run(target, memoryBody('周报三段式'), 'mem-decline');

    expect(result.success).toBe(false);
    expect(mocks.confirmation).toHaveBeenCalledTimes(1);
    expect(permissionRequests).toHaveLength(0);
    await expect(fs.access(target)).rejects.toThrow();
    expect(await fs.readFile(indexPath, 'utf8')).toBe(originalIndex);
  });

  it('模型自己写 INDEX.md 仍要这一次的规则确认，宿主不改写内容', async () => {
    const indexPath = path.join(memoryDir, 'INDEX.md');
    const content = '# model index\nkept prose\n';
    const result = await run(indexPath, content, 'mem-index');

    expect(result.success, result.error).toBe(true);
    expect(mocks.confirmation).toHaveBeenCalledTimes(1);
    expect(permissionRequests).toHaveLength(0);
    expect(await fs.readFile(indexPath, 'utf8')).toBe(content);
  });
});
