import type { ErasedExportColumn, ExportCellValue } from './types.js';

/** RFC 4180 line ending; used between every row, including after the header. */
const LINE_END = '\r\n';

const NEEDS_QUOTING = /[",\r\n]/;

const escapeField = (value: string): string =>
  NEEDS_QUOTING.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const cellText = (value: ExportCellValue): string => (value === null ? '' : String(value));

/**
 * Renders a table as CSV: comma-separated, RFC 4180 quoting, `\r\n` endings.
 * An empty `rows` list still yields the header line, so an empty report
 * downloads as a file a spreadsheet can open rather than an empty blob.
 */
export const renderCsv = (
  columns: readonly ErasedExportColumn[],
  rows: readonly unknown[],
): string => {
  const header = columns.map((column) => escapeField(column.key));
  const body = rows.map((row) => columns.map((column) => escapeField(cellText(column.get(row)))));
  return [header, ...body].map((line) => line.join(',') + LINE_END).join('');
};
