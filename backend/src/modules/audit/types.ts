import { z } from 'zod';

export type AuditJsonPrimitive = string | number | boolean | null;
export type AuditJsonValue =
  AuditJsonPrimitive | AuditJsonValue[] | { readonly [key: string]: AuditJsonValue };

export interface AuditEvent {
  readonly actorId?: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly changes?: unknown;
  readonly metadata?: unknown;
  readonly ipAddress?: string | null;
}

export interface AuditRecordDto {
  readonly id: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly changes: AuditJsonValue | null;
  readonly metadata: AuditJsonValue | null;
  readonly ipAddress: string | null;
  readonly createdAt: Date;
}

/**
 * The published shape of an audit record. The interface above stays the type the
 * code works with, because its JSON payloads are recursive; on the wire both
 * payloads are objects, and that is what the description promises.
 */
export const auditRecordSchema = z
  .object({
    id: z.uuid(),
    actorId: z.uuid().nullable(),
    action: z.string(),
    entityType: z.string(),
    entityId: z.uuid().nullable(),
    changes: z.record(z.string(), z.unknown()).nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    ipAddress: z.string().nullable(),
    createdAt: z.date(),
  })
  .meta({ id: 'AuditRecord' });

export interface AuditListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly actorId?: string;
  readonly action?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
}

export type AuditHistoryQuery = Pick<
  AuditListQuery,
  'page' | 'pageSize' | 'action' | 'createdFrom' | 'createdTo'
>;

export interface AuditListResult {
  readonly items: readonly AuditRecordDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
