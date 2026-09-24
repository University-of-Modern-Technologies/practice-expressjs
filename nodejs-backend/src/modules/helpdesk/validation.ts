import { z } from 'zod';
import { ticketChannels, ticketPriorities, ticketSortFields, ticketStatuses } from './types.js';

const idParams = z.object({ id: z.string().uuid() });
const timestamp = z.string().datetime({ offset: true });
const version = z.coerce.number().int().positive();
const subject = z.string().trim().min(1).max(200);
const body = z.string().trim().min(1).max(5000);

export const listTicketsSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().min(1).max(160).optional(),
      status: z.enum(ticketStatuses).optional(),
      channel: z.enum(ticketChannels).optional(),
      priority: z.enum(ticketPriorities).optional(),
      contactId: z.string().uuid().optional(),
      assigneeId: z.string().uuid().optional(),
      ownerId: z.string().uuid().optional(),
      openedFrom: timestamp.optional(),
      openedTo: timestamp.optional(),
      sortBy: z.enum(ticketSortFields).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    })
    .refine(
      (value) =>
        value.openedFrom === undefined ||
        value.openedTo === undefined ||
        Date.parse(value.openedFrom) <= Date.parse(value.openedTo),
      { message: 'openedFrom must not be later than openedTo', path: ['openedFrom'] },
    ),
});

export const getTicketSchema = z.object({ params: idParams });

export const createTicketSchema = z.object({
  body: z.object({
    ownerId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    assigneeId: z.string().uuid().optional(),
    subject,
    body,
    channel: z.enum(ticketChannels),
    priority: z.enum(ticketPriorities).optional(),
  }),
});

export const updateTicketSchema = z.object({
  params: idParams,
  body: z
    .object({
      version,
      ownerId: z.string().uuid().optional(),
      contactId: z.string().uuid().nullable().optional(),
      assigneeId: z.string().uuid().nullable().optional(),
      subject: subject.optional(),
      body: body.optional(),
      channel: z.enum(ticketChannels).optional(),
      priority: z.enum(ticketPriorities).optional(),
    })
    .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
      message: 'At least one field to update is required',
    }),
});

export const transitionTicketSchema = z.object({
  params: idParams,
  body: z.object({
    version,
    toStatus: z.enum(ticketStatuses),
    note: z.string().trim().min(1).max(500).optional(),
  }),
});

export const deleteTicketSchema = z.object({
  params: idParams,
  query: z.object({ version }),
});
