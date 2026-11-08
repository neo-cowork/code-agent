import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildMultimodalContent } from '../../../src/host/agent/messageHandling/converter';
import type { CanUseToolFn, Logger, ToolContext } from '../../../src/host/protocol/tools';
import type { MessageAttachment } from '../../../src/shared/contract';
import { globModule } from '../../../src/host/tools/modules/file/glob';
import { listDirectoryModule } from '../../../src/host/tools/modules/file/listDirectory';

const CSV_CONTENT = [
  '区域,销售额,毛利,毛利率',
  '华东,1000,320,32.0%',
  '华南,800,360,45.0%',
  '华北,900,270,30.0%',
].join('\n');

function makeLogger(): Logger {
  return { debug: () => void 0, info: () => void 0, warn: () => void 0, error: () => void 0 };
}

function makeCtx(sessionId: string, workingDir: string): ToolContext {
  return {
    sessionId,
    workingDir,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  };
}

function makeCsvAttachment(attachmentPath?: string): MessageAttachment {
  return {
    id: 'sales-csv',
    type: 'file',
    category: 'data',
    name: 'inject.csv',
    size: Buffer.byteLength(CSV_CONTENT),
    mimeType: 'text/csv',
    language: 'csv',
    data: CSV_CONTENT,
    ...(attachmentPath ? { path: attachmentPath } : {}),
  };
}

function modelBoundText(attachment: MessageAttachment): string {
  return buildMultimodalContent(
    '分析这张销售表：哪个区域毛利率最高？给出结论。',
    [attachment],
  )
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('first-turn CSV attachments in an unmaterialized planned work directory', () => {
  let tmpHome: string;
  let previousHome: string | undefined;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'planned-workdir-attachment-'));
    previousHome = process.env.CODE_AGENT_HOME;
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_HOME = tmpHome;
    process.env.CODE_AGENT_DATA_DIR = path.join(tmpHome, '.code-agent');
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.CODE_AGENT_HOME;
    else process.env.CODE_AGENT_HOME = previousHome;
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('session_1793532442678_37e1ce43: inline CSV with path remains model-visible before first ListDirectory returns planned-empty', async () => {
    const plannedWorkDir = path.join(tmpHome, 'Neo', '任务_1102_分析这张销售表');
    const attachmentPath = path.join(tmpHome, 'uploads', 'inject.csv');
    const modelText = modelBoundText(makeCsvAttachment(attachmentPath));

    expect(modelText).toContain(CSV_CONTENT);
    expect(modelText).toContain(`📍 路径: ${attachmentPath}`);
    await expect(fs.stat(plannedWorkDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const listHandler = await listDirectoryModule.createHandler();
    const listResult = await listHandler.execute(
      { path: plannedWorkDir, recursive: true },
      makeCtx('session_1793532442678_37e1ce43', plannedWorkDir),
      allowAll,
    );

    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.output).toContain('(empty — this task folder has no files yet)');
      expect(listResult.output).not.toContain('Directory not found');
    }
    await expect(fs.stat(plannedWorkDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('session_1793588032317_bd0135d3: inline CSV without path survives first Glob then planned-empty ListDirectory', async () => {
    const plannedWorkDir = path.join(tmpHome, 'Neo', '任务_1102_读取附件inject');
    const modelText = modelBoundText(makeCsvAttachment());

    expect(modelText).toContain(CSV_CONTENT);
    expect(modelText).not.toContain('📍 路径:');
    await expect(fs.stat(plannedWorkDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const globHandler = await globModule.createHandler();
    const globResult = await globHandler.execute(
      { pattern: '**/*.{xlsx,xls,csv}', path: plannedWorkDir },
      makeCtx('session_1793588032317_bd0135d3', plannedWorkDir),
      allowAll,
    );

    expect(globResult.ok).toBe(true);
    if (globResult.ok) expect(globResult.output).toBe('No files matched the pattern');
    await expect(fs.stat(plannedWorkDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const listHandler = await listDirectoryModule.createHandler();
    const listResult = await listHandler.execute(
      { path: plannedWorkDir, recursive: true },
      makeCtx('session_1793588032317_bd0135d3', plannedWorkDir),
      allowAll,
    );

    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.output).toContain('(empty — this task folder has no files yet)');
      expect(listResult.output).not.toContain('Directory not found');
    }
    await expect(fs.stat(plannedWorkDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
