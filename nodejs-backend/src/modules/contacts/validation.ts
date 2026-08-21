import { z } from 'zod';
import { contactSortFields } from './types.js';

const idParams = z.object({ id: z.string().uuid() });
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const email = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((value) => value.toLowerCase());
const phone = z.string().trim().min(1).max(32);

export const listContactsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().min(1).max(160).optional(),
    ownerId: z.string().uuid().optional(),
    sortBy: z.enum(contactSortFields).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

export const getContactSchema = z.object({ params: idParams });

export const createContactSchema = z.object({
  body: z
    .object({
      ownerId: z.string().uuid().optional(),
      firstName: z.string().trim().min(1).max(80),
      lastName: z.string().trim().min(1).max(80),
      email: email.optional(),
      phone: phone.optional(),
      company: z.string().trim().min(1).max(160).optional(),
      notes: z.string().trim().min(1).optional(),
    })
    .refine((value) => Boolean(value.email || value.phone), {
      message: 'Email or phone is required',
      path: ['email'],
    }),
});

export const updateContactSchema = z.object({
  params: idParams,
  body: z
    .object({
      ownerId: z.string().uuid().optional(),
      firstName: z.string().trim().min(1).max(80).optional(),
      lastName: z.string().trim().min(1).max(80).optional(),
      email: email.nullable().optional(),
      phone: phone.nullable().optional(),
      company: optionalText(160),
      notes: z.string().trim().min(1).nullable().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, 'At least one field is required'),
});

export const deleteContactSchema = z.object({ params: idParams });
