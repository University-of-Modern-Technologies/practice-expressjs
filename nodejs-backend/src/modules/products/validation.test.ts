import { createProductSchema, listProductsSchema } from './validation.js';

const validBody = {
  sku: 'widget-1',
  name: 'Widget',
  unitPrice: '19.99',
  currency: 'usd',
};

const parseBody = (overrides: Record<string, unknown>) =>
  createProductSchema.safeParse({ body: { ...validBody, ...overrides } });

describe('products validation: monetary amounts', () => {
  // The column stores two decimal places, so the grammar has to reject what it
  // could not store faithfully rather than round it silently.
  it.each([
    ['12.555', 'more precision than the column holds'],
    ['-1', 'negative'],
    ['1e3', 'scientific notation'],
    ['', 'empty'],
    ['12,50', 'comma as the decimal mark'],
    ['1234567890123', 'wider than twelve digits'],
  ])('rejects %s (%s)', (unitPrice) => {
    expect(parseBody({ unitPrice }).success).toBe(false);
  });

  it.each([['0'], ['19.9'], ['19.99'], ['999999999999.99']])('accepts %s', (unitPrice) => {
    expect(parseBody({ unitPrice }).success).toBe(true);
  });

  it('trims the amount before matching it', () => {
    const parsed = parseBody({ unitPrice: '  19.99  ' });

    expect(parsed.success).toBe(true);
  });
});

describe('products validation: SKU', () => {
  it.each([
    ['', 'empty'],
    ['-leading-dash', 'starts with punctuation'],
    ['has space', 'contains a space'],
    ['слово', 'outside the allowed alphabet'],
  ])('rejects %s (%s)', (sku) => {
    expect(parseBody({ sku }).success).toBe(false);
  });

  it('upper-cases what it accepts, so the same article cannot be entered twice', () => {
    const parsed = parseBody({ sku: 'widget-1' });

    expect(parsed.success && parsed.data.body.sku).toBe('WIDGET-1');
  });
});

describe('products validation: list filters', () => {
  // The flag arrives as text on the query string and as a boolean from a
  // service call; both spellings have to mean the same thing.
  it.each([
    ['true', true],
    ['false', false],
    [true, true],
    [false, false],
  ])('reads isActive=%s as %s', (input, expected) => {
    const parsed = listProductsSchema.safeParse({ query: { isActive: input } });

    expect(parsed.success && parsed.data.query.isActive).toBe(expected);
  });
});
