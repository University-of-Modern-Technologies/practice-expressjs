import { describe, expect, it } from '@jest/globals';

import {
  createDealSchema,
  deleteDealSchema,
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
