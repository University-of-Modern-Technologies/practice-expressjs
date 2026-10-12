import mongoose, { Schema, type Model } from 'mongoose';
import type { Logger } from 'pino';

import type { DomainEventDocument, DomainEventModelPort } from './types.js';

export const DOMAIN_EVENT_MODEL_NAME = 'DomainEvent';
export const DOMAIN_EVENT_COLLECTION = 'domain_events';

export const SECONDS_PER_DAY = 24 * 60 * 60;

// The names are the sibling backend's: the same collection layout is described
// the same way in both, so an index listing reads identically whichever one
// built it.
export const EVENT_TYPE_INDEX = 'event_type_idx';
export const ENTITY_HISTORY_INDEX = 'entity_history_idx';
export const ACTOR_HISTORY_INDEX = 'actor_history_idx';
export const RETENTION_INDEX = 'occurred_at_ttl_idx';

export type IndexKeys = Readonly<Record<string, 1 | -1>>;

export interface EventLogIndexSpec {
  readonly name: string;
  readonly keys: IndexKeys;
  readonly expireAfterSeconds?: number;
}

/** The indexes the log depends on, in the order they are created. */
export const eventLogIndexes = (retentionDays: number): readonly EventLogIndexSpec[] => [
  // Search filtered by event type alone.
  { name: EVENT_TYPE_INDEX, keys: { eventType: 1 } },
  // Entity history: newest first for one entity.
  { name: ENTITY_HISTORY_INDEX, keys: { entityType: 1, entityId: 1, occurredAt: -1 } },
  // Actor-scoped search and analytics.
  { name: ACTOR_HISTORY_INDEX, keys: { actorId: 1, occurredAt: -1 } },
  // Retention: the server prunes an event once the window elapses, so nothing
  // in the application has to own a cleanup job.
  {
    name: RETENTION_INDEX,
    keys: { occurredAt: 1 },
    expireAfterSeconds: retentionDays * SECONDS_PER_DAY,
  },
];

/** The slice of the driver's collection that index maintenance needs. */
export interface EventLogIndexCollection {
  createIndex(
    keys: IndexKeys,
    options: { name: string; expireAfterSeconds?: number },
  ): Promise<unknown>;
  indexes(): Promise<readonly { name?: string; key: Record<string, unknown> }[]>;
  dropIndex(name: string): Promise<unknown>;
}

/**
 * What the server answers when an index cannot be created as asked because one
 * already exists that is almost the same: the same name for other keys or
 * options (86 / 85), or the same keys under another name (85).
 */
const INDEX_CONFLICT_CODES = new Set([85, 86]);

const isIndexConflict = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'number' &&
  INDEX_CONFLICT_CODES.has(error.code);

const sameKeys = (left: Record<string, unknown>, right: IndexKeys): boolean => {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([field, direction], position) =>
        rightEntries[position]?.[0] === field && rightEntries[position][1] === direction,
    )
  );
};

/**
 * Creates one index, replacing whatever stands in its way: an older definition
 * under the same name, or the same keys under another name (what the schema's
 * own `autoIndex` used to create). Without the replacement a single changed
 * definition rejects the request, and every index after it is never created.
 */
const ensureIndex = async (
  collection: EventLogIndexCollection,
  spec: EventLogIndexSpec,
  logger: Logger,
): Promise<void> => {
  const options =
    spec.expireAfterSeconds === undefined
      ? { name: spec.name }
      : { name: spec.name, expireAfterSeconds: spec.expireAfterSeconds };
  try {
    await collection.createIndex(spec.keys, options);
  } catch (error) {
    if (!isIndexConflict(error)) throw error;

    const existing = await collection.indexes();
    const obstacles = existing
      .filter((index) => index.name === spec.name || sameKeys(index.key, spec.keys))
      .map((index) => index.name)
      .filter((name): name is string => typeof name === 'string' && name !== '_id_');
    logger.info({ index: spec.name, replaced: obstacles }, 'Replacing an outdated event log index');
    for (const name of obstacles) await collection.dropIndex(name);
    await collection.createIndex(spec.keys, options);
  }
};

/**
 * Creates the indexes the log depends on. Idempotent, and run on every
 * connection — production included: the retention index is what keeps an
 * append-only collection from growing without bound, so it cannot be left to
 * the schema's development-only `autoIndex`.
 */
export const ensureEventLogIndexes = async (
  collection: EventLogIndexCollection,
  retentionDays: number,
  logger: Logger,
): Promise<void> => {
  for (const spec of eventLogIndexes(retentionDays)) {
    await ensureIndex(collection, spec, logger);
  }
};

const buildSchema = (): Schema<DomainEventDocument> => {
  // The schema definition is described without the document generic: inferring
  // it through mongoose's mapped types exceeds the compiler's recursion budget,
  // and the shape is asserted once on the way out instead.
  const schema = new Schema(
    {
      eventType: { type: String, required: true, trim: true },
      entityType: { type: String, required: true, trim: true },
      entityId: { type: String, required: true, trim: true },
      actorId: { type: String, required: false, default: null },
      requestId: { type: String, required: false, default: null },
      payload: { type: Schema.Types.Mixed, required: false, default: null },
      occurredAt: { type: Date, required: true, default: (): Date => new Date() },
    },
    {
      collection: DOMAIN_EVENT_COLLECTION,
      strict: true,
      // The stream is append-only, so mongoose document versioning adds no value.
      versionKey: false,
      minimize: false,
      timestamps: false,
    },
  );

  // The indexes are not declared on the schema: they are created explicitly by
  // `ensureEventLogIndexes`, with names, so there is one definition of them.
  return schema as unknown as Schema<DomainEventDocument>;
};

/**
 * Registers (or reuses) the DomainEvent model. Model compilation is global to the
 * mongoose instance, so repeated calls must not throw an OverwriteModelError.
 */
export const getDomainEventModel = (): Model<DomainEventDocument> => {
  const existing = mongoose.models[DOMAIN_EVENT_MODEL_NAME] as
    Model<DomainEventDocument> | undefined;
  if (existing) return existing;

  return mongoose.model<DomainEventDocument>(DOMAIN_EVENT_MODEL_NAME, buildSchema());
};

/** Narrow port consumed by the event store service (see `types.ts`). */
export const getDomainEventModelPort = (): DomainEventModelPort =>
  getDomainEventModel() as unknown as DomainEventModelPort;
