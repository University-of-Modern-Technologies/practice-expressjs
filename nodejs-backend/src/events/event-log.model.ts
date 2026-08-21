import mongoose, { Schema, type Model } from 'mongoose';

import type { AppConfig } from '../config/env.js';
import type { DomainEventDocument, DomainEventModelPort } from './types.js';

export const DOMAIN_EVENT_MODEL_NAME = 'DomainEvent';
export const DOMAIN_EVENT_COLLECTION = 'domain_events';

const SECONDS_PER_DAY = 24 * 60 * 60;

const buildSchema = (retentionDays: number): Schema<DomainEventDocument> => {
  // The schema definition is described without the document generic: inferring
  // it through mongoose's mapped types exceeds the compiler's recursion budget,
  // and the shape is asserted once on the way out instead.
  const schema = new Schema(
    {
      eventType: { type: String, required: true, trim: true, index: true },
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

  // Entity history lookups: newest first for a single entity.
  schema.index({ entityType: 1, entityId: 1, occurredAt: -1 });
  // Actor-scoped analytics and search filters.
  schema.index({ actorId: 1, occurredAt: -1 });
  // TTL: MongoDB prunes events once the configured retention window elapses.
  schema.index({ occurredAt: 1 }, { expireAfterSeconds: retentionDays * SECONDS_PER_DAY });

  return schema as unknown as Schema<DomainEventDocument>;
};

/**
 * Registers (or reuses) the DomainEvent model. Model compilation is global to the
 * mongoose instance, so repeated calls must not throw an OverwriteModelError.
 */
export const getDomainEventModel = (config: AppConfig): Model<DomainEventDocument> => {
  const existing = mongoose.models[DOMAIN_EVENT_MODEL_NAME] as
    Model<DomainEventDocument> | undefined;
  if (existing) return existing;

  return mongoose.model<DomainEventDocument>(
    DOMAIN_EVENT_MODEL_NAME,
    buildSchema(config.eventLogRetentionDays),
  );
};

/** Narrow port consumed by the event store service (see `types.ts`). */
export const getDomainEventModelPort = (config: AppConfig): DomainEventModelPort =>
  getDomainEventModel(config) as unknown as DomainEventModelPort;
