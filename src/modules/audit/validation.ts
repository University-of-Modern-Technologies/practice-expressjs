import { z } from 'zod';

const optionalDate = z.iso.datetime({ offset: true }).optional();

export const listAuditSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    actorId: z.uuid().optional(),
    action: z.string().trim().min(1).max(64).optional(),
    entityType: z.string().trim().min(1).max(64).optional(),
    entityId: z.uuid().optional(),
    createdFrom: optionalDate,
    createdTo: optionalDate,
  }),
});

export const auditHistorySchema = z.object({
  params: z.object({
    resource: z.string().trim().min(1).max(64),
    resourceId: z.uuid(),
  }),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    action: z.string().trim().min(1).max(64).optional(),
    createdFrom: optionalDate,
    createdTo: optionalDate,
  }),
});

export const getAuditSchema = z.object({ params: z.object({ id: z.uuid() }) });
