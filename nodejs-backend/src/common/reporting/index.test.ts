import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_REPORT_WINDOW_FROM,
  MAX_REPORT_WINDOW_DAYS,
  defaultReportWindowTo,
} from './index.js';

const DAY_MS = 86_400_000;

describe('default report window', () => {
  it('ends at the next UTC midnight', () => {
    expect(defaultReportWindowTo(Date.parse('2026-09-30T13:45:00.000Z'))).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('gives the whole day one end, so the day shares one cache entry', () => {
    expect(defaultReportWindowTo(Date.parse('2026-09-30T00:00:00.000Z'))).toBe(
      defaultReportWindowTo(Date.parse('2026-09-30T23:59:59.999Z')),
    );
  });

  it('reads the day in UTC whatever zone the clock is written in', () => {
    expect(defaultReportWindowTo(Date.parse('2026-10-01T01:00:00+03:00'))).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('stays under the ceiling for years', () => {
    const farAhead = Date.parse(defaultReportWindowTo(Date.parse('2030-12-31T00:00:00.000Z')));

    expect(farAhead - Date.parse(DEFAULT_REPORT_WINDOW_FROM)).toBeLessThanOrEqual(
      MAX_REPORT_WINDOW_DAYS * DAY_MS,
    );
  });
});
