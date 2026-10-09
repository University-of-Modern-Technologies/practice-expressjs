import { describe, expect, it } from '@jest/globals';

import {
  createDealSchema,
  deleteDealSchema,
  listDealsSchema,
  transitionDealSchema,
  updateDealSchema,
} from './validation.js';

const id = '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836';
const validDeal = {
  title: 'New opportunity',
  amount: '1000.00',
};

describe('create deal validation', () => {
  it('allows an omitted or explicit LEAD stage', () => {
    expect(createDealSchema.safeParse({ body: validDeal }).success).toBe(true);
    expect(createDealSchema.safeParse({ body: { ...validDeal, stage: 'LEAD' } }).success).toBe(
      true,
    );
  });

  it.each(['QUALIFIED', 'PROPOSAL', 'WON', 'LOST'])('rejects the %s stage at creation', (stage) => {
    expect(createDealSchema.safeParse({ body: { ...validDeal, stage } }).success).toBe(false);
  });

  it('accepts the amount only as a decimal string, never as a JSON number', () => {
    // Money crosses the API as a string; a number would already have lost precision.
    expect(createDealSchema.safeParse({ body: { ...validDeal, amount: 1000 } }).success).toBe(
      false,
    );
    expect(
      updateDealSchema.safeParse({ params: { id }, body: { version: 1, amount: 1000.5 } }).success,
    ).toBe(false);
  });
});

describe('deal mutation validation', () => {
  it('requires a positive version and an actual field for regular updates', () => {
    expect(
      updateDealSchema.safeParse({ params: { id }, body: { version: 1, probability: 25 } }).success,
    ).toBe(true);
    expect(updateDealSchema.safeParse({ params: { id }, body: { probability: 25 } }).success).toBe(
      false,
    );
    expect(updateDealSchema.safeParse({ params: { id }, body: { version: 1 } }).success).toBe(
      false,
    );
  });

  it('requires a version for stage transitions', () => {
    expect(
      transitionDealSchema.safeParse({
        params: { id },
        body: { version: 1, stage: 'QUALIFIED' },
      }).success,
    ).toBe(true);
    expect(
      transitionDealSchema.safeParse({ params: { id }, body: { stage: 'QUALIFIED' } }).success,
    ).toBe(false);
  });

  it('requires a version query parameter for deletion', () => {
    expect(deleteDealSchema.safeParse({ params: { id }, query: { version: '1' } }).success).toBe(
      true,
    );
    expect(deleteDealSchema.safeParse({ params: { id }, query: {} }).success).toBe(false);
  });
});

describe('deal dates', () => {
  it.each(['2026-02-31', '2026-13-01', '2025-02-29', '2026-00-10'])(
    'refuses %s, which is not a calendar date',
    (date) => {
      expect(
        createDealSchema.safeParse({ body: { ...validDeal, expectedCloseDate: date } }).success,
      ).toBe(false);
      expect(listDealsSchema.safeParse({ query: { expectedCloseFrom: date } }).success).toBe(false);
    },
  );

  it('accepts a leap day in a leap year', () => {
    expect(
      createDealSchema.safeParse({ body: { ...validDeal, expectedCloseDate: '2028-02-29' } })
        .success,
    ).toBe(true);
  });
});

describe('numbers in a deal body', () => {
  it.each([null, '', '3', true, false])('refuses %p where a number belongs', (value) => {
    expect(
      updateDealSchema.safeParse({ params: { id }, body: { version: value, title: 'Renamed' } })
        .success,
    ).toBe(false);
    expect(
      transitionDealSchema.safeParse({
        params: { id },
        body: { version: 1, stage: 'QUALIFIED', probability: value },
      }).success,
    ).toBe(false);
    expect(createDealSchema.safeParse({ body: { ...validDeal, probability: value } }).success).toBe(
      false,
    );
  });

  it('still reads numbers from the query string', () => {
    expect(deleteDealSchema.safeParse({ params: { id }, query: { version: '3' } }).success).toBe(
      true,
    );
    expect(listDealsSchema.safeParse({ query: { minProbability: '10' } }).success).toBe(true);
  });
});

describe('deal list bounds', () => {
  it('puts an upper bound on the page number', () => {
    expect(listDealsSchema.safeParse({ query: { page: '1000000' } }).success).toBe(true);
    expect(listDealsSchema.safeParse({ query: { page: '1000001' } }).success).toBe(false);
  });

  it('refuses a search made of whitespace only', () => {
    expect(listDealsSchema.safeParse({ query: { search: '   ' } }).success).toBe(false);
  });
});
