import type { z } from 'zod';

import { listAuditSchema } from '../../modules/audit/validation.js';
import { listCallsSchema } from '../../modules/calls/validation.js';
import { listContactsSchema } from '../../modules/contacts/validation.js';
import { listDealsSchema } from '../../modules/deals/validation.js';
import { listTransactionsSchema } from '../../modules/finance/validation.js';
import { listTicketsSchema } from '../../modules/helpdesk/validation.js';
import { listOrdersSchema } from '../../modules/orders/validation.js';
import { listProductsSchema } from '../../modules/products/validation.js';
import { listUsersSchema } from '../../modules/users/validation.js';
import { listMovementsSchema } from '../../modules/warehouse/validation.js';
import { MAX_PAGE } from './pagination.js';

const lists: readonly (readonly [string, z.ZodType])[] = [
  ['audit', listAuditSchema],
  ['calls', listCallsSchema],
  ['contacts', listContactsSchema],
  ['deals', listDealsSchema],
  ['finance transactions', listTransactionsSchema],
  ['helpdesk', listTicketsSchema],
  ['orders', listOrdersSchema],
  ['products', listProductsSchema],
  ['users', listUsersSchema],
  ['stock movements', listMovementsSchema],
];

const withPage = (page: number): { query: { page: string } } => ({ query: { page: String(page) } });

describe('the page bound shared by every list', () => {
  it('is one hundred pages', () => {
    expect(MAX_PAGE).toBe(100);
  });

  it.each(lists)('%s serves the last page and refuses the one after it', (_name, schema) => {
    expect(schema.safeParse(withPage(MAX_PAGE)).success).toBe(true);
    expect(schema.safeParse(withPage(MAX_PAGE + 1)).success).toBe(false);
  });
});
