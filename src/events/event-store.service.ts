import type { Logger } from 'pino';

import type { AppConfig } from '../config/env.js';
import { sanitizeEventPayload } from './sanitize.js';
import type {
  DomainEventDocument,
  DomainEventDto,
  DomainEventInput,
  DomainEventModelPort,
  DomainEventRecord,
  EntityHistoryQuery,
  EventFilter,
  EventListResult,
  EventSearchQuery,
} from './types.js';
import { domainEventSchema } from './validation.js';

export interface EventStoreService {
  /**
   * Fire-and-forget append. Never throws: business transactions in PostgreSQL must
   * not be affected by the event store being unavailable or by a malformed event.
   */
  append(event: DomainEventInput): Promise<void>;
  listByEntity(query: EntityHistoryQuery): Promise<EventListResult>;
  search(query: EventSearchQuery): Promise<EventListResult>;
}

export interface EventStoreDependencies {
  /** Injected in unit tests; production resolves the mongoose model lazily. */
  readonly model?: DomainEventModelPort;
}

const toId = (value: unknown): string =>
  typeof value === 'string' ? value : String(value as { toString(): string });

const toDto = (record: DomainEventRecord): DomainEventDto => ({
  id: toId(record._id),
  eventType: record.eventType,
  entityType: record.entityType,
  entityId: record.entityId,
  actorId: record.actorId ?? null,
  requestId: record.requestId ?? null,
  payload: record.payload ?? null,
  occurredAt: record.occurredAt,
});

const buildOccurredAtFilter = (from?: Date, to?: Date): EventFilter =>
  from || to
    ? {
        occurredAt: {
          ...(from ? { $gte: from } : {}),
          ...(to ? { $lte: to } : {}),
        },
      }
    : {};

export const createEventStoreService = (
  logger: Logger,
  config: AppConfig,
  dependencies: EventStoreDependencies = {},
): EventStoreService => {
  let model: DomainEventModelPort | null = dependencies.model ?? null;

  const resolveModel = async (): Promise<DomainEventModelPort> => {
    // Imported on demand so callers that inject a model never load the driver.
    model ??= (await import('./event-log.model.js')).getDomainEventModelPort(config);
    return model;
  };

  const paginate = async (
    filter: EventFilter,
    page: number,
    pageSize: number,
  ): Promise<EventListResult> => {
    const store = await resolveModel();
    const skip = (page - 1) * pageSize;
    const [records, total] = await Promise.all([
      store.find(filter).sort({ occurredAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean().exec(),
      store.countDocuments(filter).exec(),
    ]);

    return { items: records.map(toDto), page, pageSize, total };
  };

  return {
    async append(event) {
      try {
        const parsed = domainEventSchema.safeParse(event);
        if (!parsed.success) {
          logger.warn(
            { eventType: event.eventType, issues: parsed.error.issues },
            'Dropped a malformed domain event',
          );
          return;
        }

        const document: DomainEventDocument = {
          eventType: parsed.data.eventType,
          entityType: parsed.data.entityType,
          entityId: parsed.data.entityId,
          actorId: parsed.data.actorId ?? null,
          requestId: parsed.data.requestId ?? null,
          payload: sanitizeEventPayload(parsed.data.payload),
          occurredAt: parsed.data.occurredAt ?? new Date(),
        };

        const store = await resolveModel();
        await store.create(document);
      } catch (error) {
        logger.error({ err: error, eventType: event.eventType }, 'Failed to append a domain event');
      }
    },

    async listByEntity({ entityType, entityId, page, pageSize }) {
      return paginate({ entityType, entityId }, page, pageSize);
    },

    async search({ eventType, actorId, from, to, page, pageSize }) {
      const filter: EventFilter = {
        ...(eventType ? { eventType } : {}),
        ...(actorId ? { actorId } : {}),
        ...buildOccurredAtFilter(from, to),
      };
      return paginate(filter, page, pageSize);
    },
  };
};
