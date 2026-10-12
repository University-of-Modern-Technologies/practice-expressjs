import { z } from 'zod';

import { versionNumberSchema } from '../../common/openapi/index.js';
import type { PermissionScope } from '../rbac/types.js';

export const callDirections = ['INBOUND', 'OUTBOUND'] as const;
export type CallDirection = (typeof callDirections)[number];

export const callDispositions = ['ANSWERED', 'NO_ANSWER', 'BUSY', 'FAILED', 'VOICEMAIL'] as const;
export type CallDisposition = (typeof callDispositions)[number];

/** E.164, the form the switchboard reports numbers in. */
const PHONE_PATTERN = /^\+[1-9]\d{1,14}$/;

const phoneNumber = z.string().max(32).regex(PHONE_PATTERN);

export const callSchema = z
  .object({
    id: z.uuid(),
    externalId: z.string().min(1).max(64),
    direction: z.enum(callDirections),
    disposition: z.enum(callDispositions),
    fromNumber: phoneNumber,
    toNumber: phoneNumber,
    startedAt: z.date(),
    durationSeconds: z.int().min(0),
    contactId: z.uuid().nullable(),
    dealId: z.uuid().nullable(),
    // Nobody's call until somebody claims it; see the scope note in the service.
    ownerId: z.uuid().nullable(),
    recordingUrl: z.string().max(512).nullable(),
    notes: z.string().max(2000).nullable(),
    version: versionNumberSchema,
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'Call' });

export type CallDto = Readonly<z.infer<typeof callSchema>>;

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
export const callSyncResultSchema = z.object({
  fetched: z.int().min(0),
  created: z.int().min(0),
  skipped: z.int().min(0),
});

export type CallSyncResult = Readonly<z.infer<typeof callSyncResultSchema>>;

export const callRecordingSchema = z.object({
  url: z.string().max(512),
  expiresAt: z.date(),
});

export type CallRecordingDto = Readonly<z.infer<typeof callRecordingSchema>>;

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
