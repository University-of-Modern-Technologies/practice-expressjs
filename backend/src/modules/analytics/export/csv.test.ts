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

  // A cell a spreadsheet would evaluate is made literal.
  it('neutralises a cell that would be read as a formula', () => {
    const csv = renderCsv(columns, [
      { name: '=HYPERLINK("http://x","y")', amount: '1.00' },
      { name: '+1+1', amount: '2.00' },
      { name: '@SUM(A1)', amount: '3.00' },
      { name: '-cmd', amount: '4.00' },
      { name: '\tTab', amount: '5.00' },
      { name: '\rReturn', amount: '6.00' },
    ]);

    expect(csv).toBe(
      'name,amount\r\n' +
        '"\'=HYPERLINK(""http://x"",""y"")",1.00\r\n' +
        "'+1+1,2.00\r\n" +
        "'@SUM(A1),3.00\r\n" +
        "'-cmd,4.00\r\n" +
        "'\tTab,5.00\r\n" +
        '"\'\rReturn",6.00\r\n',
    );
  });

  it('leaves a negative number a number', () => {
    expect(renderCsv(columns, [{ name: '-12', amount: '-0.50' }])).toBe(
      'name,amount\r\n-12,-0.50\r\n',
    );
  });
});
