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
