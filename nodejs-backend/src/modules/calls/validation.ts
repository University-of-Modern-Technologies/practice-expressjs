import { z } from 'zod';
import { callDirections, callDispositions, callSortFields } from './types.js';

const idParams = z.object({ id: z.string().uuid() });
const timestamp = z.string().datetime({ offset: true });
const version = z.coerce.number().int().positive();
const boolean = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

export const listCallsSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().min(1).max(160).optional(),
      direction: z.enum(callDirections).optional(),
      disposition: z.enum(callDispositions).optional(),
      contactId: z.string().uuid().optional(),
      dealId: z.string().uuid().optional(),
      ownerId: z.string().uuid().optional(),
      startedFrom: timestamp.optional(),
      startedTo: timestamp.optional(),
      hasContact: boolean.optional(),
      sortBy: z.enum(callSortFields).default('startedAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    })
    .refine(
      (value) =>
        value.startedFrom === undefined ||
        value.startedTo === undefined ||
        Date.parse(value.startedFrom) <= Date.parse(value.startedTo),
      { message: 'startedFrom must not be later than startedTo', path: ['startedFrom'] },
    ),
});

export const getCallSchema = z.object({ params: idParams });

/**
 * Sync takes no parameters: which batch is pulled is the provider's business,
 * and how large it may be is a deployment setting. Anything a caller sends is
 * dropped rather than honoured, so a client cannot widen the import by hand.
 */
export const syncCallsSchema = z.object({ body: z.object({}).optional() });

/**
 * Only the four fields a human decides. The direction, the numbers, the
 * duration and the outcome came from the switchboard, and the journal is worth
 * nothing if they can be edited afterwards — so they are not in the schema at
 * all, and a body that carries them is accepted with them stripped.
 */
export const updateCallSchema = z.object({
  params: idParams,
  body: z
    .object({
      version,
      ownerId: z.string().uuid().nullable().optional(),
      contactId: z.string().uuid().nullable().optional(),
      dealId: z.string().uuid().nullable().optional(),
      notes: z.string().trim().min(1).max(2000).nullable().optional(),
    })
    .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
      message: 'At least one field to update is required',
    }),
});

/**
 * Linking attaches a call to what it was about. Detaching is an update, not a
 * link, which is why neither side accepts `null` here.
 */
export const linkCallSchema = z.object({
  params: idParams,
  body: z
    .object({
      version,
      contactId: z.string().uuid().optional(),
      dealId: z.string().uuid().optional(),
    })
    .refine((value) => value.contactId !== undefined || value.dealId !== undefined, {
      message: 'A contact or a deal is required',
    }),
});

export const getCallRecordingSchema = z.object({ params: idParams });

export const deleteCallSchema = z.object({
  params: idParams,
  query: z.object({ version }),
});
