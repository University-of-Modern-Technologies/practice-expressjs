import type { ErasedExportColumn, ExportCellValue } from './types.js';

/** RFC 4180 line ending; used between every row, including after the header. */
const LINE_END = '\r\n';

const NEEDS_QUOTING = /[",\r\n]/;

const escapeField = (value: string): string =>
  NEEDS_QUOTING.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/**
 * A cell a spreadsheet would read as a formula: one that opens with `=`, `+`,
 * `-` or `@`, or with a tab or carriage return that some of them skip before
 * looking. A product name or an owner's name is typed by a person, and a file
 * that runs `=HYPERLINK(...)` when a manager opens it is the export doing the
 * attacker's work.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * A plain decimal — a count, an amount, a rate — which a spreadsheet reads as
 * a number whatever its sign. It is left exactly as the report rendered it:
 * prefixing `-12.50` would turn a figure into text and protect nothing.
 */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Neutralises a cell that would otherwise be evaluated, by the convention the
 * spreadsheets themselves honour: a leading apostrophe makes the rest literal.
 */
const neutraliseFormula = (text: string): string =>
  FORMULA_TRIGGER.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;

const cellText = (value: ExportCellValue): string =>
  value === null ? '' : neutraliseFormula(String(value));

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
