import { AppError } from '../../common/errors/index.js';
import { filter } from '../../common/query/filter-builder.js';
import { createListReader } from '../../common/query/list-reader.js';
import { Prisma, type PrismaDatabase, type PrismaTransaction } from '../../db/prisma.js';
import type { PermissionScope } from '../rbac/types.js';
import { sanitizeAuditValue } from './sanitize.js';
import type {
  AuditEvent,
  AuditHistoryQuery,
  AuditJsonValue,
  AuditListQuery,
  AuditListResult,
  AuditRecordDto,
} from './types.js';

interface AuditRecord {
  readonly id: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly changes: unknown;
  readonly metadata: unknown;
  readonly ipAddress: string | null;
  readonly createdAt: Date;
}

export type AuditTransaction = Pick<PrismaTransaction, 'auditLog'>;
export type AuditDatabase = Pick<PrismaDatabase, 'auditLog'>;

export interface AuditService {
  record(transaction: AuditTransaction, event: AuditEvent): Promise<AuditRecordDto>;
  list(actorId: string, scope: PermissionScope, query: AuditListQuery): Promise<AuditListResult>;
  history(
    actorId: string,
    scope: PermissionScope,
    resource: string,
    resourceId: string,
    query: AuditHistoryQuery,
  ): Promise<AuditListResult>;
  getById(actorId: string, scope: PermissionScope, id: string): Promise<AuditRecordDto>;
}

const auditSelection = {
  id: true,
  actorId: true,
  action: true,
  entityType: true,
  entityId: true,
  changes: true,
  metadata: true,
  ipAddress: true,
  createdAt: true,
};

const toDto = (record: AuditRecord): AuditRecordDto => ({
  ...record,
  changes: record.changes as AuditJsonValue | null,
  metadata: record.metadata as AuditJsonValue | null,
});

const toPrismaJson = (value: unknown) => {
  const sanitized = sanitizeAuditValue(value);
  return sanitized === null ? Prisma.JsonNull : (sanitized as Prisma.InputJsonValue);
};

export const createAuditService = (db: AuditDatabase): AuditService => {
  const readPage = createListReader({ model: db.auditLog, select: auditSelection, toDto });

  const service: AuditService = {
    async record(transaction, event) {
      const record = await transaction.auditLog.create({
        data: {
          actorId: event.actorId ?? null,
          action: event.action,
          entityType: event.entityType,
          entityId: event.entityId ?? null,
          ...(event.changes === undefined ? {} : { changes: toPrismaJson(event.changes) }),
          ...(event.metadata === undefined ? {} : { metadata: toPrismaJson(event.metadata) }),
          ipAddress: event.ipAddress ?? null,
        },
        select: auditSelection,
      });
      return toDto(record);
    },

    async list(actorId, scope, query) {
      const where = filter<Prisma.AuditLogWhereInput>()
        .equals('actorId', scope === 'OWN' ? actorId : query.actorId)
        .equals('action', query.action)
        .equals('entityType', query.entityType)
        .equals('entityId', query.entityId)
        .range('createdAt', query.createdFrom, query.createdTo)
        .build();
      return readPage({
        where,
        page: query.page,
        pageSize: query.pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    },

    async history(actorId, scope, resource, resourceId, query) {
      return service.list(actorId, scope, {
        ...query,
        entityType: resource,
        entityId: resourceId,
      });
    },

    async getById(actorId, scope, id) {
      const record = await db.auditLog.findFirst({
        where: { id, ...(scope === 'OWN' ? { actorId } : {}) },
        select: auditSelection,
      });
      if (!record) throw new AppError('Audit record not found', 404, 'AUDIT_RECORD_NOT_FOUND');
      return toDto(record);
    },
  };

  return service;
};
