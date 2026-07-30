/**
 * Shape shared by every export format. Money and text stay as the report
 * already rendered them (a formatted decimal string, in particular) so a
 * renderer never re-derives a value the report already computed.
 */
export type ExportCellValue = string | number | boolean | null;

export const exportFormats = ['csv', 'json'] as const;
export type ExportFormat = (typeof exportFormats)[number];

/** One exported column, typed against the row shape a report actually returns. */
export interface ExportColumn<Row> {
  readonly key: string;
  readonly get: (row: Row) => ExportCellValue;
}

/**
 * A column with its row type erased to `unknown`.
 *
 * The export registry holds five reports with five different row shapes side
 * by side in one map, so something has to erase the type. Erasing it here,
 * at the single point where a descriptor is built, keeps the unsafe cast out
 * of the controller and out of every individual report definition.
 */
export interface ErasedExportColumn {
  readonly key: string;
  readonly get: (row: unknown) => ExportCellValue;
}
