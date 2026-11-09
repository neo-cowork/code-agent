import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { pptGenerateModule } from '../../../../../src/host/tools/modules/network/pptGenerate';
import { excelGenerateModule } from '../../../../../src/host/tools/modules/network/excelGenerate';

const allowAll: CanUseToolFn = async () => ({ allow: true });
const originalPptFlag = process.env.ENABLE_LEGACY_PPT_GENERATE;

function makeCtx(workingDir: string): ToolContext {
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    sessionId: 'office-markdown-test',
    workingDir,
    abortSignal: new AbortController().signal,
    logger,
    emit: () => undefined,
  } as unknown as ToolContext;
}

async function expectNoStarsInOfficeXml(filePath: string): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith('.xml')) continue;
    expect(await zip.files[name].async('string'), name).not.toContain('**');
  }
}

describe('Office generators do not leak inline Markdown stars', () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), 'office-markdown-'));
    process.env.ENABLE_LEGACY_PPT_GENERATE = '1';
  });

  afterEach(async () => {
    if (originalPptFlag === undefined) delete process.env.ENABLE_LEGACY_PPT_GENERATE;
    else process.env.ENABLE_LEGACY_PPT_GENERATE = originalPptFlag;
    await rm(workingDir, { recursive: true, force: true });
  });

  it('ppt_generate strips marked topic and slide text and defaults into the task working directory', async () => {
    const result = await pptGenerateModule.createHandler().execute({
      topic: '**会议**',
      content: '# **标题**\n- **粗体** *斜体* `代码`',
      research: false,
      review: false,
    }, makeCtx(workingDir), allowAll);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const filePath = String(result.meta?.filePath);
    expect(dirname(filePath)).toBe(workingDir);
    await expectNoStarsInOfficeXml(filePath);
  });

  it('excel_generate strips marked title, headers and cells and defaults into the task working directory', async () => {
    const result = await excelGenerateModule.createHandler().execute({
      title: '**表格**',
      data: '| **事项** | *负责人* | `期限` |\n|---|---|---|\n| **发布** | *张三* | `周一` |',
    }, makeCtx(workingDir), allowAll);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const filePath = String(result.meta?.filePath);
    expect(dirname(filePath)).toBe(workingDir);
    await expectNoStarsInOfficeXml(filePath);
  });
});
