import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import { Packer } from 'docx';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import { docxGenerateModule } from '../../../../../src/host/tools/modules/network/docxGenerate';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(workingDir: string, overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir,
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  workingDir: string,
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(workingDir),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = docxGenerateModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

async function documentXml(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  const document = zip.file('word/document.xml');
  expect(document).not.toBeNull();
  return document!.async('string');
}

describe('docxGenerateModule (native)', () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), 'docx-generate-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(workingDir, { recursive: true, force: true });
  });

  describe('schema', () => {
    it('has correct metadata', () => {
      expect(docxGenerateModule.schema.name).toBe('docx_generate');
      expect(docxGenerateModule.schema.category).toBe('network');
      expect(docxGenerateModule.schema.permissionLevel).toBe('write');
      expect(docxGenerateModule.schema.readOnly).toBe(false);
      expect(docxGenerateModule.schema.allowInPlanMode).toBe(false);
      expect(docxGenerateModule.schema.inputSchema.required).toEqual(['title', 'content']);
    });

    it('exposes 4 themes via enum', () => {
      const themeProp = (docxGenerateModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>).theme;
      expect(themeProp.enum).toEqual(['professional', 'academic', 'minimal', 'creative']);
    });
  });

  describe('validation & error gates', () => {
    it('rejects missing title', async () => {
      const result = await run(workingDir, { content: 'body' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing content', async () => {
      const result = await run(workingDir, { title: 'T' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty title', async () => {
      const result = await run(workingDir, { title: '', content: 'body' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run(workingDir, { title: 'T', content: 'body' }, makeCtx(workingDir), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx(workingDir, { abortSignal: ctrl.signal });
      const result = await run(workingDir, { title: 'T', content: 'body' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('happy path and output location', () => {
    it('writes a real docx with default theme and Agent Neo author in the task working directory', async () => {
      const result = await run(workingDir, { title: '报告', content: '# 标题\n正文' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Word 文档已生成');
        expect(result.output).toContain('professional');
        const meta = result.meta as Record<string, unknown>;
        const filePath = String(meta.filePath);
        expect(dirname(filePath)).toBe(workingDir);
        expect(meta.fileSize).toBeGreaterThan(0);
        expect(meta.artifact).toMatchObject({
          kind: 'document',
          sourceTool: 'docx_generate',
          path: filePath,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          metadata: { title: '报告', theme: 'professional', author: 'Agent Neo' },
        });
        expect((await readFile(filePath)).length).toBeGreaterThan(0);
        expect((await readdir(workingDir)).filter((name) => name.endsWith('.docx'))).toHaveLength(1);
      }
    });

    it('respects custom absolute output_path', async () => {
      const outputPath = join(workingDir, 'custom.docx');
      const result = await run(workingDir, { title: 'T', content: 'body', output_path: outputPath });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.meta?.filePath).toBe(outputPath);
      expect((await readFile(outputPath)).length).toBeGreaterThan(0);
    });

    it('resolves a relative output_path inside the explicit task working directory', async () => {
      const expectedPath = join(workingDir, 'report.docx');
      const result = await run(workingDir, { title: 'T', content: 'body', output_path: 'report.docx' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.meta?.filePath).toBe(expectedPath);
        expect(result.output).toContain(expectedPath);
      }
      expect((await readFile(expectedPath)).length).toBeGreaterThan(0);
    });

    it('creates output directory if missing', async () => {
      const outputPath = join(workingDir, 'nested', 'report.docx');
      const result = await run(workingDir, { title: 'T', content: 'body', output_path: outputPath });
      expect(result.ok).toBe(true);
      expect((await readFile(outputPath)).length).toBeGreaterThan(0);
    });

    it('honors all 4 themes', async () => {
      for (const theme of ['professional', 'academic', 'minimal', 'creative']) {
        const result = await run(workingDir, { title: 'T', content: 'body', theme, output_path: `${theme}.docx` });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.meta?.theme).toBe(theme);
      }
    });
  });

  describe('markdown rendering with real generated docx', () => {
    it('converts inline markers to styled runs for every text-bearing element without star residue', async () => {
      const outputPath = join(workingDir, 'minutes.docx');
      const content = [
        '# **会议时间** *09:00* `weekly`',
        '## **主持人**',
        '### **参会人员**',
        '- **会议时间**：2026-11-09 *上午* `room-A`',
        '* *斜体列表* and **粗体列表**',
        '1. **行动项** *今天* `owner`',
        '> **结论** *通过* `decision`',
        '| **事项** | *负责人* | `期限` |',
        '|---|---|---|',
        '| **发布** | *张三* | `周一` |',
      ].join('\n');
      const result = await run(workingDir, { title: '**会议纪要**', content, output_path: outputPath });
      expect(result.ok).toBe(true);

      const xml = await documentXml(outputPath);
      expect(xml).not.toContain('**');
      expect(xml).not.toMatch(/<w:t(?:\s[^>]*)?>\s*(?:#{1,3}|[-*]|\d+\.|&gt;)\s+/);
      for (const text of ['会议纪要', '会议时间', '主持人', '参会人员', '行动项', '结论', '事项', '发布']) {
        expect(xml).toContain(text);
      }
      expect(xml).toMatch(/<w:r>(?:(?!<\/w:r>)[\s\S])*<w:b\/>(?:(?!<\/w:r>)[\s\S])*<w:t[^>]*>会议时间<\/w:t>/);
      expect(xml).toMatch(/<w:r>(?:(?!<\/w:r>)[\s\S])*<w:i\/>(?:(?!<\/w:r>)[\s\S])*<w:t[^>]*>斜体列表<\/w:t>/);
      expect(xml).toContain('w:ascii="Consolas"');
    });
  });

  describe('error handling', () => {
    it('returns failure when Packer.toBuffer throws', async () => {
      vi.spyOn(Packer, 'toBuffer').mockRejectedValueOnce(new Error('docx-fail'));
      const result = await run(workingDir, { title: 'T', content: 'body' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('docx-fail');
    });
  });

  describe('onProgress', () => {
    it('emits starting and completing stages', async () => {
      const onProgress = vi.fn();
      await run(workingDir, { title: 'T', content: 'body' }, makeCtx(workingDir), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});
