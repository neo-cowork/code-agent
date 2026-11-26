/** ExcelAutomate action policy shared by execution, approval and step labels. */
export const EXCEL_READ_ACTIONS: ReadonlySet<string> = new Set(['read', 'list_sheets', 'get_range', 'validate_formulas']);
export const EXCEL_WRITE_ACTIONS: ReadonlySet<string> = new Set(['edit', 'generate']);
