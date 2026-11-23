import type { ElectronAPI } from '../../shared/ipc/api';
import { columnLetter, type SheetRangeStart } from '../../shared/livePreview/sheetCoords';

type ExcelSheetPreview = NonNullable<Awaited<ReturnType<ElectronAPI['extractExcelJson']>>>['sheets'][number];

export function buildExcelSheetPreview(
  name: string,
  trimmed: unknown[][],
  rangeStart: SheetRangeStart,
): ExcelSheetPreview {
  const firstRow = trimmed[0] ?? [];
  const headerless = trimmed.length === 1;
  const headers = headerless
    ? Array.from({ length: firstRow.length }, (_, index) => columnLetter(rangeStart.column + index))
    : Array.from(firstRow, (cell) => String(cell ?? ''));

  return {
    name,
    headers,
    rows: headerless ? [firstRow] : trimmed.slice(1, 501), // Render at most 500 data rows.
    rowCount: headerless ? 1 : Math.max(trimmed.length - 1, 0),
    ...(rangeStart.row !== 0 || rangeStart.column !== 0 ? { rangeStart } : {}),
    ...(headerless ? { headerless } : {}),
  };
}
