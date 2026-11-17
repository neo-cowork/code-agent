import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import os from 'os';
import * as path from 'path';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { ToolRegistry } from '../../../../../src/host/tools/registry';
import { globModule } from '../../../../../src/host/tools/modules/file/glob';
import { listDirectoryModule } from '../../../../../src/host/tools/modules/file/listDirectory';
import { grepModule } from '../../../../../src/host/tools/modules/shell/grep';

const toolCases = [
  { name: 'Glob', module: globModule, args: { pattern: '**/*.txt' }, pathKey: 'searchPath' },
  { name: 'ListDirectory', module: listDirectoryModule, args: {}, pathKey: 'dirPath' },
  { name: 'Grep', module: grepModule, args: { pattern: 'needle' }, pathKey: 'searchPath' },
] as const;

const directoryToolCases = [
  { ...toolCases[1], emptyOutput: 'no files yet' },
  { ...toolCases[2], emptyOutput: 'No matches found' },
] as const;

type ToolCase = typeof toolCases[number];
type DirectoryToolCase = typeof directoryToolCases[number];

const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeLogger(): Logger {
  return { debug: () => void 0, info: () => void 0, warn: () => void 0, error: () => void 0 };
}

function makeCtx(workingDir: string): ToolContext {
  return {
    sessionId: 'tilde-path-resolution-test',
    workingDir,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  };
}

async function executeRegistered(toolCase: ToolCase | DirectoryToolCase, inputPath: string, workingDir: string) {
  const registry = new ToolRegistry();
  registry.register(toolCase.module.schema, async () => toolCase.module);
  const handler = await registry.resolve(toolCase.name);
  return handler.execute({ ...toolCase.args, path: inputPath }, makeCtx(workingDir), allowAll);
}

describe('registered file search tools share home and relative path resolution', () => {
  let tempDir: string;
  let home: string;
  let workspace: string;
  let previousProcessHome: string | undefined;
  let previousHomeEnv: string | undefined;
  let previousDataDirEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-tilde-path-'));
    home = path.join(tempDir, 'home');
    workspace = path.join(tempDir, 'workspace');
    await fs.mkdir(path.join(home, 'sub'), { recursive: true });
    await fs.mkdir(path.join(home, 'x'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'sub'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'x'), { recursive: true });
    await fs.writeFile(path.join(home, 'home.txt'), 'home needle\n');
    await fs.writeFile(path.join(home, 'sub', 'needle.txt'), 'home needle\n');
    await fs.writeFile(path.join(workspace, 'sub', 'needle.txt'), 'workspace needle\n');
    await fs.writeFile(path.join(home, 'x', 'home-only.txt'), 'home-only needle\n');
    await fs.writeFile(path.join(workspace, 'x', 'workspace-only.txt'), 'workspace-only needle\n');
    previousProcessHome = process.env.HOME;
    previousHomeEnv = process.env.CODE_AGENT_HOME;
    previousDataDirEnv = process.env.CODE_AGENT_DATA_DIR;
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (previousProcessHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousProcessHome;
    if (previousHomeEnv === undefined) delete process.env.CODE_AGENT_HOME;
    else process.env.CODE_AGENT_HOME = previousHomeEnv;
    if (previousDataDirEnv === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDirEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each(toolCases)('$name resolves ~, ~/sub and a relative path through its registered handler', async (toolCase) => {
    const cases = [
      ['~', home],
      ['~/sub', path.join(home, 'sub')],
      ['sub', path.join(workspace, 'sub')],
    ] as const;

    for (const [inputPath, expectedPath] of cases) {
      const result = await executeRegistered(toolCase, inputPath, workspace);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.meta?.[toolCase.pathKey]).toBe(expectedPath);
    }
  });

  it.each(directoryToolCases)('$name reads ~/x from the temp HOME, not <workspace>/~/x', async (toolCase) => {
    const result = await executeRegistered(toolCase, '~/x', workspace);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.[toolCase.pathKey]).toBe(path.join(home, 'x'));
      expect(result.output).toContain('home-only');
      expect(result.output).not.toContain('workspace-only');
    }
  });

  it.each(directoryToolCases)('$name treats missing ~/Neo as the planned-empty default work root without creating it', async (toolCase) => {
    process.env.CODE_AGENT_HOME = home;
    process.env.CODE_AGENT_DATA_DIR = path.join(home, '.code-agent');
    const workRoot = path.join(home, 'Neo');

    const result = await executeRegistered(toolCase, '~/Neo', workspace);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain(toolCase.emptyOutput);
      expect(result.meta?.[toolCase.pathKey]).toBe(workRoot);
    }
    await expect(fs.stat(workRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
