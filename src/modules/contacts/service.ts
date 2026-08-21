import { AppError } from '../../common/errors/index.js';
import { filter } from '../../common/query/filter-builder.js';
import { createListReader } from '../../common/query/list-reader.js';
import type { Prisma, PrismaDatabase, PrismaTransaction } from '../../db/prisma.js';
import type { AuditService } from '../audit/service.js';
import type {
  ContactAccess,
  ContactDto,
  ContactListQuery,
  ContactListResult,
  CreateContactData,
  UpdateContactData,
} from './types.js';

interface ContactRecord extends ContactDto {
  readonly deletedAt: Date | null;
}

type ContactsTransaction = Pick<PrismaTransaction, 'auditLog' | 'contact'>;
export type ContactsDatabase = Pick<PrismaDatabase, '$transaction' | 'contact'>;

export interface ContactsService {
  list(access: ContactAccess, query: ContactListQuery): Promise<ContactListResult>;
  getById(access: ContactAccess, id: string): Promise<ContactDto>;
  create(access: ContactAccess, data: CreateContactData): Promise<ContactDto>;
  update(access: ContactAccess, id: string, data: UpdateContactData): Promise<ContactDto>;
  delete(access: ContactAccess, id: string): Promise<void>;
}

const contactSelection = {
  id: true,
  ownerId: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  company: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
};

const toDto = ({ deletedAt: _deletedAt, ...contact }: ContactRecord): ContactDto => contact;

const ensureOwnerAccess = (access: ContactAccess, ownerId: string): void => {
  if (access.scope === 'OWN' && ownerId !== access.actorId) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
};

const duplicateWhere = (
  email: string | null | undefined,
  phone: string | null | undefined,
  excludeId?: string,
): Prisma.ContactWhereInput => ({
  deletedAt: null,
  ...(excludeId ? { id: { not: excludeId } } : {}),
  OR: [
    ...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }] : []),
    ...(phone ? [{ phone }] : []),
  ],
});

const assertNoDuplicate = async (
  transaction: ContactsTransaction,
  email: string | null | undefined,
  phone: string | null | undefined,
  excludeId?: string,
): Promise<void> => {
  const duplicate = await transaction.contact.findFirst({
    where: duplicateWhere(email, phone, excludeId),
    select: { id: true },
  });
  if (duplicate) {
    throw new AppError(
      'An active contact with this email or phone already exists',
      409,
      'CONTACT_DUPLICATE',
    );
  }
};

const findActive = async (
  contactStore: ContactsTransaction['contact'],
  access: ContactAccess,
  id: string,
): Promise<ContactRecord> => {
  const contact = await contactStore.findFirst({
    where: { id, deletedAt: null, ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}) },
    select: contactSelection,
  });
  if (!contact) throw new AppError('Contact not found', 404, 'CONTACT_NOT_FOUND');
  return contact;
};

const mapPersistenceError = (error: unknown): never => {
  if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
    throw new AppError(
      'An active contact with this email or phone already exists',
      409,
      'CONTACT_DUPLICATE',
    );
  }
  throw error;
};

export const createContactsService = (
  db: ContactsDatabase,
  audit: AuditService,
): ContactsService => {
  const readPage = createListReader({ model: db.contact, select: contactSelection, toDto });

  return {
    async list(access, query) {
      const ownerId = access.scope === 'OWN' ? access.actorId : query.ownerId;
      const where = filter<Prisma.ContactWhereInput>({ deletedAt: null })
        .equals('ownerId', ownerId)
        .search(query.search, [
          'firstName',
          'lastName',
          'email',
          { field: 'phone', insensitive: false },
          'company',
        ])
        .build();
      return readPage({
        where,
        page: query.page,
        pageSize: query.pageSize,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
      });
    },

    async getById(access, id) {
      return toDto(await findActive(db.contact, access, id));
    },

    async create(access, data) {
      const ownerId = data.ownerId ?? access.actorId;
      ensureOwnerAccess(access, ownerId);
      try {
        return await db.$transaction(async (transaction) => {
          await assertNoDuplicate(transaction, data.email, data.phone);
          const contact = await transaction.contact.create({
            data: {
              ownerId,
              firstName: data.firstName,
              lastName: data.lastName,
              email: data.email ?? null,
              phone: data.phone ?? null,
              company: data.company ?? null,
              notes: data.notes ?? null,
            },
            select: contactSelection,
          });
          const dto = toDto(contact);
          await audit.record(transaction, {
            actorId: access.actorId,
            action: 'contact.created',
            entityType: 'contact',
            entityId: contact.id,
            changes: { after: dto },
            ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
          });
          return dto;
        });
      } catch (error) {
        return mapPersistenceError(error);
      }
    },

    async update(access, id, data) {
      try {
        return await db.$transaction(async (transaction) => {
          const existing = await findActive(transaction.contact, access, id);
          const ownerId = data.ownerId ?? existing.ownerId;
          ensureOwnerAccess(access, ownerId);
          const email = data.email === undefined ? existing.email : data.email;
          const phone = data.phone === undefined ? existing.phone : data.phone;
          if (!email && !phone) {
            throw new AppError('Email or phone is required', 400, 'CONTACT_CHANNEL_REQUIRED');
          }
          await assertNoDuplicate(transaction, email, phone, id);
          const updateData: Prisma.ContactUncheckedUpdateInput = {
            ...(data.ownerId !== undefined ? { ownerId: data.ownerId } : {}),
            ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
            ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
            ...(data.email !== undefined ? { email: data.email } : {}),
            ...(data.phone !== undefined ? { phone: data.phone } : {}),
            ...(data.company !== undefined ? { company: data.company } : {}),
            ...(data.notes !== undefined ? { notes: data.notes } : {}),
          };
          const updated = await transaction.contact.update({
            where: { id },
            data: updateData,
            select: contactSelection,
          });
          const before = toDto(existing);
          const after = toDto(updated);
          await audit.record(transaction, {
            actorId: access.actorId,
            action: 'contact.updated',
            entityType: 'contact',
            entityId: id,
            changes: { before, after },
            ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
          });
          return after;
        });
      } catch (error) {
        return mapPersistenceError(error);
      }
    },

    async delete(access, id) {
      await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.contact, access, id);
        const deletedAt = new Date();
        await transaction.contact.update({
          where: { id },
          data: { deletedAt },
          select: contactSelection,
        });
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'contact.deleted',
          entityType: 'contact',
          entityId: id,
          changes: { before: toDto(existing), after: { deletedAt } },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
      });
    },
  };
};
