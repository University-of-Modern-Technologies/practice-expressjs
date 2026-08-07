import { z } from 'zod';
import { productSortFields } from './types.js';

const idParams = z.object({ id: z.string().uuid() });
const money = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Invalid monetary amount');
const version = z.coerce.number().int().positive();
const currency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());
const sku = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Invalid SKU')
  .transform((value) => value.toUpperCase());
const boolean = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

export const listProductsSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().min(1).max(160).optional(),
      category: z.string().trim().min(1).max(80).optional(),
      isActive: boolean.optional(),
      minPrice: money.optional(),
      maxPrice: money.optional(),
      sortBy: z.enum(productSortFields).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    })
    .refine(
      (value) =>
        !value.minPrice || !value.maxPrice || Number(value.minPrice) <= Number(value.maxPrice),
      { message: 'minPrice must not exceed maxPrice', path: ['minPrice'] },
    ),
});

export const getProductSchema = z.object({ params: idParams });

export const createProductSchema = z.object({
  body: z.object({
    sku,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4000).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    unitPrice: money,
    currency: currency.optional(),
    isActive: z.boolean().optional(),
  }),
});

export const updateProductSchema = z.object({
  params: idParams,
  // `sku` is intentionally not accepted here; the identifier of a catalogue
  // entry must stay stable for the order lines that reference it.
  body: z
    .object({
      version,
      name: z.string().trim().min(1).max(160).optional(),
      description: z.string().trim().max(4000).nullable().optional(),
      category: z.string().trim().min(1).max(80).nullable().optional(),
      unitPrice: money.optional(),
      currency: currency.optional(),
      isActive: z.boolean().optional(),
    })
    .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
      message: 'At least one field to update is required',
    }),
});

export const deleteProductSchema = z.object({
  params: idParams,
  query: z.object({ version }),
});
