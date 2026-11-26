// ============================================================================
// 读文件类工具的 ~ 展开回归：全部走共享 resolveInputPath（同 Glob/List/Grep）。
// 每个用例：fake HOME 下的文件以 ~/<name> 引用时被真正找到（或到达工具真实的
// 「不支持的格式」分支），且错误/结果路径绝不出现 <workspace>/~。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import os from 'os';
import * as path from 'path';
import type { CanUseToolFn, Logger, ToolContext, ToolModule } from '../../../../../src/host/protocol/tools';
import { ToolRegistry } from '../../../../../src/host/tools/registry';
import { readPdfModule } from '../../../../../src/host/tools/modules/network/readPdf';
import { readDocxModule } from '../../../../../src/host/tools/modules/network/readDocx';
import { readXlsxModule } from '../../../../../src/host/tools/modules/network/readXlsx';
import { imageAnalyzeModule } from '../../../../../src/host/tools/modules/network/imageAnalyze';
import { pdfCompressModule } from '../../../../../src/host/tools/modules/network/pdfCompress';
import { xlwingsExecuteModule } from '../../../../../src/host/tools/modules/network/xlwingsExecute';
import { lspModule } from '../../../../../src/host/tools/modules/lsp/lsp';
import { diagnosticsModule } from '../../../../../src/host/tools/modules/lsp/diagnostics';
import { requestDirectoryModule } from '../../../../../src/host/tools/modules/file/requestDirectory';
import { excelAutomateModule } from '../../../../../src/host/tools/modules/excel/excelAutomate';
import { docEditModule } from '../../../../../src/host/tools/modules/document/docEdit';

// -----------------------------------------------------------------------------
// Heavy-dependency seams: LSP manager / Python bridge / legacy excel edit.
// 只 mock 依赖边界，路径解析走真实 fs + 真实 resolveInputPath。
// -----------------------------------------------------------------------------

const getLSPManagerMock = vi.fn();
const executePythonScriptMock = vi.fn();
const executeExcelEditMock = vi.fn();

vi.mock('../../../../../src/host/lsp', () => ({
  getLSPManager: () => getLSPManagerMock(),
}));

vi.mock('../../../../../src/host/tools/utils/pythonBridge', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executePythonScript: (...args: unknown[]) => executePythonScriptMock(...args),
}));

vi.mock('../../../../../src/host/tools/excel/excelEdit', () => ({
  executeExcelEdit: (...args: unknown[]) => executeExcelEditMock(...args),
}));

const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeLogger(): Logger {
  return { debug: () => void 0, info: () => void 0, warn: () => void 0, error: () => void 0 };
}

function makeCtx(workingDir: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'tilde-read-file-tools-test',
    agentId: 'tilde-test-agent',
    workingDir,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as ToolContext;
}

async function executeRegistered(
  module: ToolModule<Record<string, unknown>, string>,
  args: Record<string, unknown>,
  workingDir: string,
  ctxOverrides: Partial<ToolContext> = {},
) {
  const registry = new ToolRegistry();
  registry.register(module.schema, async () => module);
  const handler = await registry.resolve(module.schema.name);
  return handler.execute(args, makeCtx(workingDir, ctxOverrides), allowAll);
}

describe('registered read-file tools share home path resolution', () => {
  let tempDir: string;
  let home: string;
  let workspace: string;
  let previousProcessHome: string | undefined;
  let previousHomeEnv: string | undefined;
  let previousDataDirEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-tilde-read-'));
    home = path.join(tempDir, 'home');
    workspace = path.join(tempDir, 'workspace');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(home, 'imgs'), { recursive: true });
    await fs.writeFile(path.join(home, 'note.txt'), 'plain text fixture\n');
    await fs.writeFile(path.join(home, 'code.ts'), 'export const x = 1;\n');
    await fs.writeFile(path.join(home, 'imgs', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    previousProcessHome = process.env.HOME;
    previousHomeEnv = process.env.CODE_AGENT_HOME;
    previousDataDirEnv = process.env.CODE_AGENT_DATA_DIR;
    process.env.HOME = home;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, 'data');
    getLSPManagerMock.mockReset();
    executePythonScriptMock.mockReset();
    executeExcelEditMock.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in test')));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (previousProcessHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousProcessHome;
    if (previousHomeEnv === undefined) delete process.env.CODE_AGENT_HOME;
    else process.env.CODE_AGENT_HOME = previousHomeEnv;
    if (previousDataDirEnv === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDirEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function expectNoFakeTildePath(text: unknown) {
    const rendered = String(text ?? '');
    expect(rendered).not.toContain(path.join(workspace, '~'));
    expect(rendered).not.toContain(`${workspace}/~`);
  }

  it('read_pdf finds ~/note.txt (reaches the real not-a-pdf branch)', async () => {
    const result = await executeRegistered(readPdfModule, { file_path: '~/note.txt' }, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 文件被找到后才走到扩展名校验——旧 join 会报 ENOENT 且路径含 <workspace>/~
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('PDF');
      expectNoFakeTildePath(result.error);
    }
  });

  it('read_docx finds ~/note.txt (reaches the real unsupported-format branch)', async () => {
    const result = await executeRegistered(readDocxModule, { file_path: '~/note.txt' }, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('.docx');
      expectNoFakeTildePath(result.error);
    }
  });

  it('read_docx ENOENT names the real home path for ~/missing.docx', async () => {
    const result = await executeRegistered(readDocxModule, { file_path: '~/missing.docx' }, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ENOENT');
      expect(result.error).toContain(path.join(home, 'missing.docx'));
      expectNoFakeTildePath(result.error);
    }
  });

  it('read_xlsx reads a real ~/data.xlsx from the temp HOME', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('S1');
    sheet.addRow(['name', 'value']);
    sheet.addRow(['alpha', 1]);
    await workbook.xlsx.writeFile(path.join(home, 'data.xlsx'));

    const result = await executeRegistered(readXlsxModule, { file_path: '~/data.xlsx' }, workspace);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('data.xlsx');
      expect(result.meta?.filePath).toBe(path.join(home, 'data.xlsx'));
      expectNoFakeTildePath(result.output);
    }
  });

  it('image_analyze finds ~/note.txt and reports its real unsupported-format branch', async () => {
    const result = await executeRegistered(imageAnalyzeModule, { path: '~/note.txt' }, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('不支持的图片格式');
      expectNoFakeTildePath(result.error);
    }
  });

  it('image_analyze expands a leading ~ in glob patterns before matching', async () => {
    const result = await executeRegistered(
      imageAnalyzeModule,
      { paths: ['~/imgs/*.png'], filter: 'a cat' },
      workspace,
    );

    // 展开后 glob 命中 fake HOME 里的 a.png → 统计是 1 张；视觉模型失败也只算「处理失败」。
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('处理统计：1 张');
      expectNoFakeTildePath(result.output);
    }
  });

  it('pdf_compress finds ~/note.txt and reports its real not-a-pdf branch', async () => {
    const result = await executeRegistered(pdfCompressModule, { input_path: '~/note.txt' }, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不是 PDF 文件');
      expectNoFakeTildePath(result.error);
    }
  });

  it('lsp opens the file under the temp HOME, not <workspace>/~', async () => {
    const manager = {
      isFileOpen: vi.fn().mockReturnValue(false),
      openFile: vi.fn().mockResolvedValue(undefined),
      sendRequest: vi.fn().mockResolvedValue([]),
      getInstallFailureForFile: vi.fn().mockReturnValue(undefined),
    };
    getLSPManagerMock.mockReturnValue(manager);

    const result = await executeRegistered(
      lspModule,
      { operation: 'goToDefinition', file_path: '~/code.ts', line: 1, character: 1 },
      workspace,
    );

    expect(result.ok).toBe(true);
    expect(manager.openFile).toHaveBeenCalledWith(path.join(home, 'code.ts'), 'export const x = 1;\n');
    expect(manager.sendRequest.mock.calls[0]?.[0]).toBe(path.join(home, 'code.ts'));
    if (result.ok) expectNoFakeTildePath(result.output);
  });

  it('diagnostics scopes ~/code.ts to the real home path', async () => {
    let seenPath: string | undefined;
    getLSPManagerMock.mockReturnValue({
      getFileDiagnostics: (fp: string) => {
        seenPath = fp;
        return [];
      },
      getDiagnostics: () => new Map(),
    });

    const result = await executeRegistered(diagnosticsModule, { file_path: '~/code.ts' }, workspace);

    expect(result.ok).toBe(true);
    expect(seenPath).toBe(path.join(home, 'code.ts'));
    if (result.ok) {
      // scope 是相对路径展示：正确解析时是 ../home/code.ts，旧 join 时是 ~/code.ts
      expect(result.output).toContain('home/code.ts');
      expect(result.output).not.toContain('~/code.ts');
      expectNoFakeTildePath(result.output);
    }
  });

  it('request_directory stats a real directory under the temp HOME', async () => {
    await fs.mkdir(path.join(home, 'reqdir'), { recursive: true });

    const result = await executeRegistered(
      requestDirectoryModule,
      { path: '~/reqdir', reason: 'need fixtures' },
      workspace,
    );

    // 目录被找到后才走到 NO_PROJECT（会话未绑定 Project）；旧 join 会先报 NOT_FOUND。
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NO_PROJECT');
      expectNoFakeTildePath(result.error);
    }
  });

  it('request_directory reports the real home path for a missing ~/dir', async () => {
    const result = await executeRegistered(
      requestDirectoryModule,
      { path: '~/no-such-dir', reason: 'need fixtures' },
      workspace,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.error).toContain(path.join(home, 'no-such-dir'));
      expectNoFakeTildePath(result.error);
    }
  });

  it('ExcelAutomate validate_formulas passes the expanded home path to python', async () => {
    executePythonScriptMock.mockResolvedValue({
      success: true,
      total_formulas: 0,
      total_errors: 0,
      status: 'clean',
      error_summary: [],
    });

    const result = await executeRegistered(
      excelAutomateModule,
      { action: 'validate_formulas', file_path: '~/book.xlsx' },
      workspace,
    );

    expect(result.ok).toBe(true);
    const pyArgs = executePythonScriptMock.mock.calls[0]?.[1] as string[];
    expect(pyArgs).toEqual(['--file', path.join(home, 'book.xlsx')]);
    if (result.ok) expectNoFakeTildePath(result.output);
  });

  it('xlwings_execute passes the expanded home path to the python bridge', async () => {
    executePythonScriptMock.mockImplementation(async (_script: string, args: string[]) => {
      if (args.includes('--check')) {
        return { xlwings_available: true, excel_available: true };
      }
      return { success: true, workbook: 'w', sheet: 'S1', range: 'A1', rows: 1, cols: 1, data: [['v']] };
    });

    const result = await executeRegistered(
      xlwingsExecuteModule,
      { operation: 'read', file_path: '~/book.xlsx' },
      workspace,
    );

    expect(result.ok).toBe(true);
    const call = executePythonScriptMock.mock.calls.find(
      (c) => (c[1] as string[]).includes('--operation'),
    );
    const paramsJson = (call?.[1] as string[])[3];
    expect(JSON.parse(paramsJson).file_path).toBe(path.join(home, 'book.xlsx'));
    if (result.ok) expectNoFakeTildePath(result.output);
  });

  it('DocEdit dispatches the expanded home path to the excel editor', async () => {
    executeExcelEditMock.mockResolvedValue({ success: true, output: 'edit done', metadata: {} });

    const result = await executeRegistered(
      docEditModule,
      { file_path: '~/book.xlsx', operations: [{ action: 'set_cell', cell: 'A1', value: 1 }] },
      workspace,
    );

    expect(result.ok).toBe(true);
    const [params] = executeExcelEditMock.mock.calls[0];
    expect((params as { file_path: string }).file_path).toBe(path.join(home, 'book.xlsx'));
    if (result.ok) {
      expect(result.meta?.path).toBe(path.join(home, 'book.xlsx'));
      expectNoFakeTildePath(result.output);
    }
  });
});
