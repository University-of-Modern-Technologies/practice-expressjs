import { z } from 'zod';

import { versionNumberSchema } from '../../common/openapi/index.js';
import type { PermissionScope } from '../rbac/types.js';

export const ticketChannels = ['EMAIL', 'PHONE', 'CHAT', 'WEB'] as const;
export type TicketChannel = (typeof ticketChannels)[number];

export const ticketStatuses = ['NEW', 'OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatus = (typeof ticketStatuses)[number];

export const ticketPriorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof ticketPriorities)[number];

export const ticketSchema = z
  .object({
    id: z.uuid(),
    number: z.string().regex(/^TKT-\d{8}$/),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(5000),
    channel: z.enum(ticketChannels),
    status: z.enum(ticketStatuses),
    priority: z.enum(ticketPriorities),
    ownerId: z.uuid(),
    contactId: z.uuid().nullable(),
    assigneeId: z.uuid().nullable(),
    version: versionNumberSchema,
    openedAt: z.date(),
    resolvedAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'Ticket' });

export type TicketDto = Readonly<z.infer<typeof ticketSchema>>;

export interface TicketAccess {
  readonly actorId: string;
  readonly scope: PermissionScope;
  readonly ipAddress?: string;
}

export interface CreateTicketData {
  readonly ownerId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly assigneeId?: string | undefined;
  readonly subject: string;
  readonly body: string;
  readonly channel: TicketChannel;
  readonly priority?: TicketPriority | undefined;
}

export interface UpdateTicketData {
  readonly version: number;
  readonly ownerId?: string | undefined;
  readonly contactId?: string | null | undefined;
  readonly assigneeId?: string | null | undefined;
  readonly subject?: string | undefined;
  readonly body?: string | undefined;
  readonly channel?: TicketChannel | undefined;
  readonly priority?: TicketPriority | undefined;
}

export interface TransitionTicketData {
  readonly version: number;
  readonly toStatus: TicketStatus;
  readonly note?: string | undefined;
}

/**
 * Highest page a list request may ask for: far beyond any real queue, and low
 * enough that the row offset it implies stays a small integer for the database
 * instead of making the query itself fail.
 */
export const MAX_HELPDESK_PAGE = 1_000_000;

export const ticketSortFields = [
  'createdAt',
  'updatedAt',
  'openedAt',
  'priority',
  'status',
] as const;
export type TicketSortField = (typeof ticketSortFields)[number];

export interface TicketListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | undefined;
  readonly status?: TicketStatus | undefined;
  readonly channel?: TicketChannel | undefined;
  readonly priority?: TicketPriority | undefined;
  readonly contactId?: string | undefined;
  readonly assigneeId?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly openedFrom?: string | undefined;
  readonly openedTo?: string | undefined;
  readonly sortBy: TicketSortField;
  readonly sortOrder: 'asc' | 'desc';
}

export interface TicketListResult {
  readonly items: readonly TicketDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
