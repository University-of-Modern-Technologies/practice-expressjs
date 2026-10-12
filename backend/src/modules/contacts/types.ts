import { z } from 'zod';

import type { PermissionScope } from '../rbac/types.js';

export const contactSchema = z
  .object({
    id: z.uuid(),
    ownerId: z.uuid(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.email().nullable(),
    phone: z.string().nullable(),
    company: z.string().nullable(),
    notes: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'Contact' });

export type ContactDto = Readonly<z.infer<typeof contactSchema>>;

export interface ContactAccess {
  readonly actorId: string;
  readonly scope: PermissionScope;
  readonly ipAddress?: string;
}

export interface CreateContactData {
  readonly ownerId?: string | undefined;
  readonly firstName: string;
  readonly lastName: string;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly company?: string | undefined;
  readonly notes?: string | undefined;
}

export interface UpdateContactData {
  readonly ownerId?: string | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly email?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly company?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

export const contactSortFields = [
  'createdAt',
  'updatedAt',
  'firstName',
  'lastName',
  'company',
] as const;
export type ContactSortField = (typeof contactSortFields)[number];

export interface ContactListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly sortBy: ContactSortField;
  readonly sortOrder: 'asc' | 'desc';
}

export interface ContactListResult {
  readonly items: readonly ContactDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
