import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';

// extract-excel-json / extract-excel-text / extract-pdf-text 的失败契约：
// 工具真的跑了并且拒了这份文件（损坏 / 改后缀 / 读不到）→ handler reject +
// warn 日志；工具不在（ENOENT / PyPDF2 未装）→ 照常落 read_pdf stub。
// 旧实现把三种失败全吞成空成功对象或哨兵文本，损坏文件因此伪装成空附件。

const warnSpy = vi.hoisted(() => vi.fn());
const execFileSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  isCurrentUserAdmin: () => true,
  getAdminAccessIpcError: () => null,
  assertAdminAccess: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/services/infra/logger')>()),
  createLogger: () => ({ warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: execFileSpy,
}));

import { registerSettingsHandlers } from '../../../src/host/ipc/settings.ipc';

type RawHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

let handlers: Map<string, RawHandler>;
let workDir: string;

beforeEach(async () => {
  handlers = new Map<string, RawHandler>();
  registerSettingsHandlers(
    { handle: (ch: string, fn: RawHandler) => handlers.set(ch, fn) } as never,
    () => ({}) as never,
  );
  workDir = await mkdtemp(join(tmpdir(), 'attach-extract-'));
  execFileSpy.mockReset();
  warnSpy.mockClear();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function handler(name: string): RawHandler {
  const found = handlers.get(name);
  if (!found) throw new Error(`${name} 未注册`);
  return found;
}

async function writeWorkbook(name: string): Promise<string> {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['月份', '销售额'], ['一月', 1]]), 'Sheet1');
  const filePath = join(workDir, name);
  await writeFile(filePath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return filePath;
}

describe('extract-excel-json / extract-excel-text：损坏输入必须拒绝', () => {
  it('改名为 .xlsx 的纯文本文件：extract-excel-json rejects 且 warn 记 parse failure', async () => {
    const filePath = join(workDir, 'renamed.xlsx');
    await writeFile(filePath, 'this is a plain text note, not a spreadsheet');

    await expect(handler('extract-excel-json')(null, filePath)).rejects.toThrow(/^excel extraction failed: /);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('extract-excel-json: parse failure'));
  });

  it('改名为 .xlsx 的纯文本文件：extract-excel-text rejects 且 warn 记 parse failure', async () => {
    const filePath = join(workDir, 'renamed.xlsx');
    await writeFile(filePath, 'this is a plain text note, not a spreadsheet');

    await expect(handler('extract-excel-text')(null, filePath)).rejects.toThrow(/^excel extraction failed: /);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('extract-excel-text: parse failure'));
  });

  it('截断的真实 xlsx 字节：extract-excel-json rejects（不再是 {sheets:[]} 空成功）', async () => {
    const filePath = await writeWorkbook('truncated.xlsx');
    const full = await readFile(filePath);
    await writeFile(filePath, full.subarray(0, Math.floor(full.length / 2)));

    await expect(handler('extract-excel-json')(null, filePath)).rejects.toThrow(/^excel extraction failed: /);
  });

  it('文件读不到：两个 handler 都 rejects 且 warn 记 cannot read file', async () => {
    const missing = join(workDir, 'missing.xlsx');

    await expect(handler('extract-excel-json')(null, missing)).rejects.toThrow(/^excel extraction failed: /);
    await expect(handler('extract-excel-text')(null, missing)).rejects.toThrow(/^excel extraction failed: /);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('extract-excel-json: cannot read file'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('extract-excel-text: cannot read file'));
  });

  it('有效但空的工作簿仍被接受：两个 handler 照常 resolve', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Sheet1');
    const filePath = join(workDir, 'blank.xlsx');
    await writeFile(filePath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

    await expect(handler('extract-excel-json')(null, filePath)).resolves.toMatchObject({ sheetCount: 1 });
    await expect(handler('extract-excel-text')(null, filePath)).resolves.toMatchObject({ sheetCount: 1, rowCount: 0 });
  });
});

describe('extract-pdf-text：工具拒文件 → reject；工具缺失 → read_pdf stub', () => {
  type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;
  const ENOENT = (bin: string) => Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' });

  function mockExecFile(impl: (file: string) => { error?: Error; stdout?: string }) {
    execFileSpy.mockImplementation((file: string, _args: unknown, _opts: unknown, cb: ExecCallback) => {
      const outcome = impl(file);
      if (outcome.error) cb(outcome.error);
      else cb(null, { stdout: outcome.stdout ?? '', stderr: '' });
    });
  }

  it('pdftotext / python3 全部 ENOENT → read_pdf stub（工具缺失保留的既有兜底）', async () => {
    mockExecFile((file) => ({ error: ENOENT(file) }));
    const result = await handler('extract-pdf-text')(null, '/tmp/broken.pdf') as { text: string; pageCount: number };
    expect(result.text).toContain('read_pdf');
    expect(result.pageCount).toBe(0);
  });

  it('pdftotext 非零退出（exit 1 打不开文件）→ rejects pdf extraction failed 并 warn', async () => {
    const exit1 = Object.assign(new Error('Command failed'), { code: 1, stderr: 'Error: Couldn\'t open file' });
    mockExecFile((file) => (file === '/opt/homebrew/bin/pdftotext' ? { error: exit1 } : { error: ENOENT(file) }));

    await expect(handler('extract-pdf-text')(null, '/tmp/broken.pdf')).rejects.toThrow(/^pdf extraction failed: /);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pdftotext rejected the file'));
  });

  it('pdftotext 进程级失败（signal 杀死 code=null / maxBuffer）→ 继续回落 read_pdf stub', async () => {
    const sigkill = Object.assign(new Error('Command was killed'), { code: null, signal: 'SIGABRT' });
    const maxBuffer = Object.assign(new Error('maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    mockExecFile((file) => {
      if (file === '/opt/homebrew/bin/pdftotext') return { error: sigkill };
      if (file === '/usr/local/bin/pdftotext') return { error: maxBuffer };
      return { error: ENOENT(file) };
    });

    const result = await handler('extract-pdf-text')(null, '/tmp/ok.pdf') as { text: string };
    expect(result.text).toContain('read_pdf');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pdftotext unusable'));
  });

  it('python 以 exit 2 退出（PyPDF2 未安装）→ read_pdf stub', async () => {
    const exit2 = Object.assign(new Error('Command failed'), { code: 2 });
    mockExecFile((file) => (file === 'python3' ? { error: exit2 } : { error: ENOENT(file) }));

    const result = await handler('extract-pdf-text')(null, '/tmp/broken.pdf') as { text: string; pageCount: number };
    expect(result.text).toContain('read_pdf');
    expect(result.pageCount).toBe(0);
  });

  it('python 以 exit 3 退出（PyPDF2 解析失败）→ rejects pdf extraction failed 并 warn', async () => {
    const exit3 = Object.assign(new Error('Command failed'), { code: 3, stderr: 'pdf extraction failed: EOF marker not found' });
    mockExecFile((file) => (file === 'python3' ? { error: exit3 } : { error: ENOENT(file) }));

    await expect(handler('extract-pdf-text')(null, '/tmp/broken.pdf')).rejects.toThrow(/^pdf extraction failed: /);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PyPDF2 rejected the file'));
  });

  it('pdftotext 正常出文本 → 照旧 resolve（含扫描页 pageCount 计数）', async () => {
    mockExecFile((file) => (file === '/opt/homebrew/bin/pdftotext' ? { stdout: 'page one\fpage two\f' } : { error: ENOENT(file) }));

    const result = await handler('extract-pdf-text')(null, '/tmp/ok.pdf') as { text: string; pageCount: number };
    expect(result.text).toBe('page one\fpage two\f');
    expect(result.pageCount).toBe(2);
  });
});
