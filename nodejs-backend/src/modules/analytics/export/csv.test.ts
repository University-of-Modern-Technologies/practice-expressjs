import { describe, expect, it } from '@jest/globals';

import { renderCsv } from './csv.js';
import type { ErasedExportColumn } from './types.js';

const columns: readonly ErasedExportColumn[] = [
  { key: 'name', get: (row) => (row as { name: string }).name },
  { key: 'amount', get: (row) => (row as { amount: string }).amount },
];

describe('renderCsv', () => {
  it('quotes a field carrying a comma, a double quote or a newline', () => {
    const csv = renderCsv(columns, [
      { name: 'a, b', amount: '1.00' },
      { name: 'he said "hi"', amount: '2.00' },
      { name: 'line1\nline2', amount: '3.00' },
    ]);

    expect(csv).toBe(
      'name,amount\r\n' +
        '"a, b",1.00\r\n' +
        '"he said ""hi""",2.00\r\n' +
        '"line1\nline2",3.00\r\n',
    );
  });

  it('renders only the header for an empty table', () => {
    expect(renderCsv(columns, [])).toBe('name,amount\r\n');
  });

  it('leaves a plain field unquoted', () => {
    expect(renderCsv(columns, [{ name: 'plain', amount: '10.00' }])).toBe(
      'name,amount\r\nplain,10.00\r\n',
    );
  });

  it('renders a null cell as an empty field', () => {
    const withNull: readonly ErasedExportColumn[] = [{ key: 'value', get: () => null }];
    expect(renderCsv(withNull, [{}])).toBe('value\r\n\r\n');
  });
});
