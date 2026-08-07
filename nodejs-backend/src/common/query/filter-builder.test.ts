import { describe, expect, it } from '@jest/globals';

import { filter } from './filter-builder.js';

interface Where extends Record<string, unknown> {
  readonly deletedAt: null;
  readonly ownerId?: string;
  readonly isActive?: boolean;
  readonly quantity?: number;
  readonly amount?: { readonly gte?: number; readonly lte?: number };
  readonly createdAt?: { readonly gte?: Date; readonly lte?: Date };
  readonly OR?: readonly Record<string, unknown>[];
}

describe('filter', () => {
  it('leaves out a field whose value is unset (undefined, null, or empty string)', () => {
    expect(filter<Where>().equals('ownerId', undefined).build()).toEqual({});
    expect(filter<Where>().equals('ownerId', null).build()).toEqual({});
    expect(filter<Where>().equals('ownerId', '').build()).toEqual({});
  });

  it('keeps falsy-but-real values: 0 and false', () => {
    expect(filter<Where>().equals('quantity', 0).build()).toEqual({ quantity: 0 });
    expect(filter<Where>().equals('isActive', false).build()).toEqual({ isActive: false });
  });

  it('keeps a base clause supplied up front (e.g. the soft-delete guard)', () => {
    expect(filter<Where>({ deletedAt: null }).build()).toEqual({ deletedAt: null });
  });

  it('builds a range with only a lower bound', () => {
    expect(filter<Where>().range('amount', 10, undefined).build()).toEqual({
      amount: { gte: 10 },
    });
  });

  it('builds a range with only an upper bound', () => {
    expect(filter<Where>().range('amount', undefined, 99).build()).toEqual({
      amount: { lte: 99 },
    });
  });

  it('builds a range with both bounds', () => {
    expect(filter<Where>().range('amount', 10, 99).build()).toEqual({
      amount: { gte: 10, lte: 99 },
    });
  });

  it('omits the field entirely when both bounds are unset', () => {
    expect(filter<Where>().range('amount', undefined, '').build()).toEqual({});
  });

  it('keeps a zero lower bound: it is a real value, not an absent one', () => {
    expect(filter<Where>().range('quantity', 0, undefined).build()).toEqual({
      quantity: { gte: 0 },
    });
  });

  it('applies a transform to each supplied bound', () => {
    const toDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
    expect(filter<Where>().range('createdAt', '2024-01-01', '2024-01-31', toDate).build()).toEqual({
      createdAt: { gte: toDate('2024-01-01'), lte: toDate('2024-01-31') },
    });
  });

  it('searches across multiple fields, case-insensitively by default', () => {
    expect(filter<Where>().search('abc', ['firstName', 'lastName']).build()).toEqual({
      OR: [
        { firstName: { contains: 'abc', mode: 'insensitive' } },
        { lastName: { contains: 'abc', mode: 'insensitive' } },
      ],
    });
  });

  it('allows a field to opt out of case-insensitive matching', () => {
    expect(
      filter<Where>()
        .search('555', [{ field: 'phone', insensitive: false }])
        .build(),
    ).toEqual({ OR: [{ phone: { contains: '555' } }] });
  });

  it('leaves out the OR clause entirely when the search value is unset', () => {
    expect(filter<Where>().search(undefined, ['firstName']).build()).toEqual({});
    expect(filter<Where>().search('', ['firstName']).build()).toEqual({});
  });

  it('chains multiple conditions together', () => {
    const where = filter<Where>({ deletedAt: null })
      .equals('ownerId', 'owner-1')
      .range('amount', 10, undefined)
      .search('acme', ['firstName'])
      .build();

    expect(where).toEqual({
      deletedAt: null,
      ownerId: 'owner-1',
      amount: { gte: 10 },
      OR: [{ firstName: { contains: 'acme', mode: 'insensitive' } }],
    });
  });
});
