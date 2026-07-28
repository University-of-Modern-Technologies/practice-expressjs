import { z } from 'zod';

const identifier = z.string().trim().min(1).max(128);
const shortName = z.string().trim().min(1).max(64);

/** Guards the append path: a malformed event is dropped, never persisted. */
export const domainEventSchema = z.object({
  eventType: z.string().trim().min(1).max(128),
  entityType: shortName,
  entityId: identifier,
  actorId: identifier.nullish(),
  requestId: identifier.nullish(),
  payload: z.unknown().optional(),
  occurredAt: z.date().optional(),
});

export type DomainEventSchemaOutput = z.infer<typeof domainEventSchema>;

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export const entityHistorySchema = z.object({
  params: z.object({
    entityType: shortName,
    entityId: identifier,
  }),
  query: z.object(pagination),
});

export const searchEventsSchema = z.object({
  query: z.object({
    ...pagination,
    eventType: z.string().trim().min(1).max(128).optional(),
    actorId: identifier.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
});
