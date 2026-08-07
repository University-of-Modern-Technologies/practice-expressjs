import { z } from 'zod';
import { orderSortFields, orderStatuses } from './types.js';

const idParams = z.object({ id: z.string().uuid() });
const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const money = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Invalid monetary amount');
const version = z.coerce.number().int().positive();
const quantity = z.coerce.number().int().min(1).max(1_000_000);
const currency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());

// `orderNumber`, `status` and the totals are never accepted from the client:
// the first two are allocated by the server, the totals are derived from lines.
const orderItemInput = z.object({
  productId: z.string().uuid(),
  quantity,
});

export const listOrdersSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().min(1).max(64).optional(),
      ownerId: z.string().uuid().optional(),
      contactId: z.string().uuid().optional(),
      dealId: z.string().uuid().optional(),
      status: z.enum(orderStatuses).optional(),
      minTotal: money.optional(),
      maxTotal: money.optional(),
      sortBy: z.enum(orderSortFields).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    })
    .refine(
      (value) =>
        !value.minTotal || !value.maxTotal || Number(value.minTotal) <= Number(value.maxTotal),
      { message: 'minTotal must not exceed maxTotal', path: ['minTotal'] },
    ),
});

export const getOrderSchema = z.object({ params: idParams });

// Carries no body: the duplicate is built entirely from the source order.
export const duplicateOrderSchema = z.object({ params: idParams });

export const createOrderSchema = z.object({
  body: z.object({
    ownerId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    currency: currency.optional(),
    discountTotal: money.optional(),
    taxTotal: money.optional(),
    notes: z.string().trim().max(4000).optional(),
    items: z
      .array(orderItemInput)
      .max(200)
      .refine(
        (items) => new Set(items.map((item) => item.productId)).size === items.length,
        'Each product may appear on an order only once',
      )
      .optional(),
  }),
});

export const updateOrderSchema = z.object({
  params: idParams,
  body: z
    .object({
      version,
      ownerId: z.string().uuid().optional(),
      contactId: z.string().uuid().nullable().optional(),
      dealId: z.string().uuid().nullable().optional(),
      currency: currency.optional(),
      discountTotal: money.optional(),
      taxTotal: money.optional(),
      notes: z.string().trim().max(4000).nullable().optional(),
    })
    .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
      message: 'At least one field to update is required',
    }),
});

export const addOrderItemSchema = z.object({
  params: idParams,
  body: z.object({ version, productId: z.string().uuid(), quantity }),
});

export const updateOrderItemSchema = z.object({
  params: itemParams,
  body: z.object({ version, quantity }),
});

export const removeOrderItemSchema = z.object({
  params: itemParams,
  query: z.object({ version }),
});

export const transitionOrderSchema = z.object({
  params: idParams,
  body: z.object({ version, status: z.enum(orderStatuses) }),
});

export const deleteOrderSchema = z.object({
  params: idParams,
  query: z.object({ version }),
});
