import { z } from 'zod';
import { dealSortFields, dealStages } from './types.js';

const idParams = z.object({ id: z.string().uuid() });
const money = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Invalid monetary amount');
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const probability = z.coerce.number().int().min(0).max(100);
const version = z.coerce.number().int().positive();

export const listDealsSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().min(1).max(160).optional(),
      ownerId: z.string().uuid().optional(),
      contactId: z.string().uuid().optional(),
      stage: z.enum(dealStages).optional(),
      minAmount: money.optional(),
      maxAmount: money.optional(),
      minProbability: probability.optional(),
      maxProbability: probability.optional(),
      expectedCloseFrom: dateOnly.optional(),
      expectedCloseTo: dateOnly.optional(),
      sortBy: z.enum(dealSortFields).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    })
    .refine(
      (value) =>
        !value.minAmount || !value.maxAmount || Number(value.minAmount) <= Number(value.maxAmount),
      { message: 'minAmount must not exceed maxAmount', path: ['minAmount'] },
    )
    .refine(
      (value) =>
        value.minProbability === undefined ||
        value.maxProbability === undefined ||
        value.minProbability <= value.maxProbability,
      { message: 'minProbability must not exceed maxProbability', path: ['minProbability'] },
    ),
});

export const getDealSchema = z.object({ params: idParams });

export const createDealSchema = z.object({
  body: z.object({
    ownerId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(160),
    stage: z.literal('LEAD').optional(),
    amount: money,
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
    probability: probability.optional(),
    expectedCloseDate: dateOnly.optional(),
  }),
});

export const updateDealSchema = z.object({
  params: idParams,
  body: z
    .object({
      version,
      ownerId: z.string().uuid().optional(),
      contactId: z.string().uuid().nullable().optional(),
      title: z.string().trim().min(1).max(160).optional(),
      amount: money.optional(),
      currency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .transform((value) => value.toUpperCase())
        .optional(),
      probability: probability.optional(),
      expectedCloseDate: dateOnly.nullable().optional(),
    })
    .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
      message: 'At least one field to update is required',
    }),
});

export const transitionDealSchema = z.object({
  params: idParams,
  body: z.object({ version, stage: z.enum(dealStages), probability: probability.optional() }),
});

export const deleteDealSchema = z.object({
  params: idParams,
  query: z.object({ version }),
});
