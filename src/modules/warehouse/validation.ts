import { z } from 'zod';

import { stockMovementTypes } from './types.js';

const uuid = z.string().uuid();
const quantity = z.coerce.number().int().positive().max(1_000_000_000);
const note = z.string().trim().min(1).max(255);
const referenceType = z.string().trim().min(1).max(64);
const timestamp = z.string().datetime({ offset: true });
const booleanFlag = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((v) => v === 'true'),
]);

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

const warehouseCode = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Code may contain letters, digits, hyphens and underscores')
  .transform((value) => value.toUpperCase());

const stockTarget = {
  warehouseId: uuid,
  productId: uuid,
};

export const listWarehousesSchema = z.object({
  query: z.object({
    ...pagination,
    search: z.string().trim().min(1).max(120).optional(),
    isActive: booleanFlag.optional(),
  }),
});

export const getWarehouseSchema = z.object({
  params: z.object({ id: z.uuid() }),
});

export const createWarehouseSchema = z.object({
  body: z.object({
    code: warehouseCode,
    name: z.string().trim().min(1).max(120),
    isActive: z.boolean().optional(),
  }),
});

export const updateWarehouseSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      code: warehouseCode.optional(),
      name: z.string().trim().min(1).max(120).optional(),
      isActive: z.boolean().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, {
      message: 'At least one field to update is required',
    }),
});

export const listStockSchema = z.object({
  query: z.object({
    ...pagination,
    warehouseId: uuid.optional(),
    productId: uuid.optional(),
    lowStockThreshold: z.coerce.number().int().min(0).optional(),
  }),
});

export const getStockSchema = z.object({
  params: z.object(stockTarget),
});

export const receiveStockSchema = z.object({
  body: z.object({
    ...stockTarget,
    quantity,
    referenceType: referenceType.optional(),
    referenceId: uuid.optional(),
    note: note.optional(),
  }),
});

export const issueStockSchema = z.object({
  body: z
    .object({
      ...stockTarget,
      quantity,
      fromReservation: z.boolean().optional(),
      referenceType: referenceType.optional(),
      referenceId: uuid.optional(),
      note: note.optional(),
    })
    .refine(
      (value) =>
        value.fromReservation !== true ||
        (value.referenceType !== undefined && value.referenceId !== undefined),
      {
        message: 'An issue against a reservation must name the reservation reference',
        path: ['referenceId'],
      },
    ),
});

const reservationBody = z.object({
  ...stockTarget,
  quantity,
  referenceType,
  referenceId: uuid,
  note: note.optional(),
});

export const reserveStockSchema = z.object({ body: reservationBody });
export const releaseStockSchema = z.object({ body: reservationBody });

export const adjustStockSchema = z.object({
  body: z.object({
    ...stockTarget,
    delta: z.coerce
      .number()
      .int()
      .refine((value) => value !== 0, { message: 'delta must not be zero' }),
    // Deliberately not optional: an unexplained correction is not auditable.
    note,
    referenceType: referenceType.optional(),
    referenceId: uuid.optional(),
  }),
});

export const listMovementsSchema = z.object({
  query: z
    .object({
      ...pagination,
      warehouseId: uuid.optional(),
      productId: uuid.optional(),
      type: z.enum(stockMovementTypes).optional(),
      referenceType: referenceType.optional(),
      referenceId: uuid.optional(),
      createdFrom: timestamp.optional(),
      createdTo: timestamp.optional(),
    })
    .refine(
      (value) =>
        value.createdFrom === undefined ||
        value.createdTo === undefined ||
        Date.parse(value.createdFrom) <= Date.parse(value.createdTo),
      { message: 'createdFrom must not be later than createdTo', path: ['createdFrom'] },
    ),
});
