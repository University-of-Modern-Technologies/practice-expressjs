import { describe, expect, it } from '@jest/globals';

import { summariseDealSchema } from './validation.js';

const deal = {
  id: '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836',
  title: 'Warehouse automation',
  stage: 'PROPOSAL',
};

const accepts = (expectedCloseDate: unknown): boolean =>
  summariseDealSchema.safeParse({ body: { ...deal, expectedCloseDate } }).success;

describe('the expected close date of a deal to summarise', () => {
  it('is the calendar day the deal itself carries', () => {
    expect(accepts('2026-12-31')).toBe(true);
  });

  it.each(['2026-02-31', '2026-13-01', '2026-12-31T00:00:00.000Z', 1_798_675_200_000])(
    'refuses %p, which is not a real calendar day',
    (value) => {
      expect(accepts(value)).toBe(false);
    },
  );
});
