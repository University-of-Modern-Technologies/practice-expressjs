import { z } from 'zod';

const address = z.object({
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Expected an ISO 3166-1 alpha-2 country code')
    .transform((value) => value.toUpperCase()),
  city: z.string().trim().min(1).max(120),
  postalCode: z.string().trim().min(1).max(20),
  line1: z.string().trim().min(1).max(200),
});

const parcel = z.object({
  weightGrams: z.number().int().min(1).max(1_000_000),
  lengthCm: z.number().int().min(1).max(500),
  widthCm: z.number().int().min(1).max(500),
  heightCm: z.number().int().min(1).max(500),
});

const money = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Invalid monetary amount');

export const createQuoteSchema = z.object({
  body: z.object({
    orderId: z.string().trim().min(1).max(64),
    origin: address,
    destination: address,
    parcel,
    declaredValue: money.optional(),
  }),
});

export const createShipmentSchema = z.object({
  body: z.object({
    quoteId: z.string().trim().min(1).max(128),
    orderId: z.string().trim().min(1).max(64),
    destination: address,
    parcel,
    reference: z.string().trim().min(1).max(120).optional(),
  }),
});

export const getShipmentSchema = z.object({
  params: z.object({ id: z.string().trim().min(1).max(128) }),
});
