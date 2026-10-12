import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_KYIV_WINDOW_FROM,
  defaultKyivWindowTo,
} from '../../modules/analytics/kyiv-time.js';
import { MAX_REPORT_WINDOW_DAYS } from './index.js';

const DAY_MS = 86_400_000;

describe('report window bounds', () => {
  it('keep the default window under the ceiling for years', () => {
    const farAhead = Date.parse(defaultKyivWindowTo(Date.parse('2030-12-31T00:00:00.000Z')));

    expect(farAhead - Date.parse(DEFAULT_KYIV_WINDOW_FROM)).toBeLessThanOrEqual(
      MAX_REPORT_WINDOW_DAYS * DAY_MS,
    );
  });
});
