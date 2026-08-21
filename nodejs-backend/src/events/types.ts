export type EventJsonPrimitive = string | number | boolean | null;
export type EventJsonValue =
  EventJsonPrimitive | EventJsonValue[] | { readonly [key: string]: EventJsonValue };

/**
 * Input accepted by the append-only event stream. PostgreSQL stays the source of
 * truth for domain data, so an event is a denormalised snapshot, not a record the
 * business logic may read back inside a transaction.
 */
export interface DomainEventInput {
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorId?: string | null;
  readonly requestId?: string | null;
  readonly payload?: unknown;
  readonly occurredAt?: Date;
}

export interface DomainEventDto {
  readonly id: string;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorId: string | null;
  readonly requestId: string | null;
  readonly payload: EventJsonValue;
  readonly occurredAt: Date;
}

export interface EntityHistoryQuery {
  readonly entityType: string;
  readonly entityId: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface EventSearchQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly eventType?: string;
  readonly actorId?: string;
  readonly from?: Date;
  readonly to?: Date;
}

/** Same pagination envelope the rest of the codebase returns. */
export interface EventListResult {
  readonly items: readonly DomainEventDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** Shape persisted to MongoDB after validation and sanitisation. */
export interface DomainEventDocument {
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorId: string | null;
  readonly requestId: string | null;
  readonly payload: EventJsonValue;
  readonly occurredAt: Date;
}

/** Lean document as read back from MongoDB. */
export interface DomainEventRecord extends DomainEventDocument {
  readonly _id: unknown;
}

export type EventFilter = Record<string, unknown>;

/**
 * Minimal structural port over the mongoose model. Keeping the service behind this
 * interface lets unit tests run without a live MongoDB (or the driver installed).
 */
export interface DomainEventQuery<TResult> {
  sort(spec: Record<string, 1 | -1>): DomainEventQuery<TResult>;
  skip(count: number): DomainEventQuery<TResult>;
  limit(count: number): DomainEventQuery<TResult>;
  lean(): DomainEventQuery<TResult>;
  exec(): Promise<TResult>;
}

export interface DomainEventModelPort {
  create(document: DomainEventDocument): Promise<unknown>;
  find(filter: EventFilter): DomainEventQuery<readonly DomainEventRecord[]>;
  countDocuments(filter: EventFilter): DomainEventQuery<number>;
}
