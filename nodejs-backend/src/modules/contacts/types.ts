import type { PermissionScope } from '../rbac/types.js';

export interface ContactDto {
  readonly id: string;
  readonly ownerId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly company: string | null;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

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
