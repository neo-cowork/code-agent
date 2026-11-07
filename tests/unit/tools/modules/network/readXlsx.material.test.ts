import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { isDeliverableArtifact } from '../../../../../src/shared/contract/artifactRoleRegistry';

vi.mock('../../../../../src/host/tools/dataFingerprint', () => ({
  dataFingerprintStore: { record: vi.fn() },
}));

import { readXlsxModule } from '../../../../../src/host/tools/modules/network/readXlsx';

const workDirs: string[] = [];
const allowAll: CanUseToolFn = async () => ({ allow: true });

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

afterEach(async () => {
  await Promise.all(workDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('read_xlsx source artifact role', () => {
  it('marks the workbook as material on each of four reads, leaving zero deliverable outputs', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'neo-read-xlsx-material-'));
    workDirs.push(workDir);
    const workbookPath = path.join(workDir, 'sales.xlsx');
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Sales').addRows([
      ['region', 'sales'],
      ['West', 10],
    ]);
    await workbook.xlsx.writeFile(workbookPath);
    const handler = await readXlsxModule.createHandler();
    const ctx = {
      sessionId: 'session-1',
      workingDir: workDir,
      abortSignal: new AbortController().signal,
      logger: logger(),
      emit: vi.fn(),
    } as unknown as ToolContext;

    const results = await Promise.all(Array.from({ length: 4 }, () => (
      handler.execute({ file_path: workbookPath }, ctx, allowAll)
    )));
    const artifacts = results.flatMap((result) => (
      result.ok && result.meta?.artifact ? [result.meta.artifact] : []
    ));

    expect(results.every((result) => result.ok)).toBe(true);
    expect(artifacts).toHaveLength(4);
    expect(artifacts.every((item) => item.role === 'material')).toBe(true);
    expect(artifacts.filter(isDeliverableArtifact)).toHaveLength(0);
  });
});
