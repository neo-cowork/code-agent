// CSV 表格预览文案（zh 原文原样迁入，en 新增）
export const csvTableZh = {
  emptyOrUnparseable: '空表或无法解析的 CSV',
  parseWarning: '解析告警：',
  sortBy: (column: string) => `点击排序：${column}`,
  resizeColumn: '拖动调整列宽',
  truncatedSummary: (limit: number, total: number) => `显示前 ${limit} / ${total} 行（排序/预览仅限前 ${limit} 行）`,
  sizeSummary: (rows: number, columns: number) => `${rows} 行 × ${columns} 列`,
};

export const csvTableEn: typeof csvTableZh = {
  emptyOrUnparseable: 'Empty table or unparseable CSV',
  parseWarning: 'Parse warning: ',
  sortBy: (column) => `Click to sort: ${column}`,
  resizeColumn: 'Drag to resize column',
  truncatedSummary: (limit, total) => `Showing first ${limit} of ${total} rows (sorting and preview limited to the first ${limit} rows)`,
  sizeSummary: (rows, columns) => `${rows} rows × ${columns} columns`,
};
