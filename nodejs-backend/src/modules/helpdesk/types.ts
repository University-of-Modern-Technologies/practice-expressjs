import type { PermissionScope } from '../rbac/types.js';

export const ticketChannels = ['EMAIL', 'PHONE', 'CHAT', 'WEB'] as const;
export type TicketChannel = (typeof ticketChannels)[number];

export const ticketStatuses = ['NEW', 'OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatus = (typeof ticketStatuses)[number];

export const ticketPriorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof ticketPriorities)[number];

export interface TicketDto {
  readonly id: string;
  readonly number: string;
  readonly subject: string;
  readonly body: string;
  readonly channel: TicketChannel;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly ownerId: string;
  readonly contactId: string | null;
  readonly assigneeId: string | null;
  readonly version: number;
  readonly openedAt: Date;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

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
