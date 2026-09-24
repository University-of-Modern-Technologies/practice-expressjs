import type { PermissionScope } from '../rbac/types.js';

export const callDirections = ['INBOUND', 'OUTBOUND'] as const;
export type CallDirection = (typeof callDirections)[number];

export const callDispositions = ['ANSWERED', 'NO_ANSWER', 'BUSY', 'FAILED', 'VOICEMAIL'] as const;
export type CallDisposition = (typeof callDispositions)[number];

export interface CallDto {
  readonly id: string;
  readonly externalId: string;
  readonly direction: CallDirection;
  readonly disposition: CallDisposition;
  readonly fromNumber: string;
  readonly toNumber: string;
  readonly startedAt: Date;
  readonly durationSeconds: number;
  readonly contactId: string | null;
  readonly dealId: string | null;
  /** Nobody's call until somebody claims it; see the scope note in the service. */
  readonly ownerId: string | null;
  readonly recordingUrl: string | null;
  readonly notes: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CallAccess {
  readonly actorId: string;
  readonly scope: PermissionScope;
  readonly ipAddress?: string;
}

/**
 * Only the four fields a human decides. Everything else on a call is what the
 * provider reported, and rewriting that by hand would make the journal disagree
 * with the switchboard it mirrors.
 */
export interface UpdateCallData {
  readonly version: number;
  readonly ownerId?: string | null | undefined;
  readonly contactId?: string | null | undefined;
  readonly dealId?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

export interface LinkCallData {
  readonly version: number;
  readonly contactId?: string | undefined;
  readonly dealId?: string | undefined;
}

/**
 * What one sync run did: how many records the provider handed over, how many
 * became rows, and how many were already known by their external id.
 * `fetched === created + skipped` always holds.
 */
export interface CallSyncResult {
  readonly fetched: number;
  readonly created: number;
  readonly skipped: number;
}

export interface CallRecordingDto {
  readonly url: string;
  readonly expiresAt: Date;
}

export const callSortFields = ['startedAt', 'createdAt', 'durationSeconds'] as const;
export type CallSortField = (typeof callSortFields)[number];

export interface CallListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | undefined;
  readonly direction?: CallDirection | undefined;
  readonly disposition?: CallDisposition | undefined;
  readonly contactId?: string | undefined;
  readonly dealId?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly startedFrom?: string | undefined;
  readonly startedTo?: string | undefined;
  /** `true` keeps only calls already tied to a contact, `false` only the loose ones. */
  readonly hasContact?: boolean | undefined;
  readonly sortBy: CallSortField;
  readonly sortOrder: 'asc' | 'desc';
}

export interface CallListResult {
  readonly items: readonly CallDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
