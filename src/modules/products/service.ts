import { AppError } from '../../common/errors/index.js';
import { filter } from '../../common/query/filter-builder.js';
import { createListReader } from '../../common/query/list-reader.js';
import {
  noopDomainEventPublisher,
  type DomainEventNotification,
  type DomainEventPublisher,
} from '../../common/types/domain-event-publisher.js';
import type { Prisma, PrismaDatabase, PrismaTransaction } from '../../db/prisma.js';
import type { AuditService } from '../audit/service.js';
import type {
  CreateProductData,
  ProductAccess,
  ProductDto,
  ProductListQuery,
  ProductListResult,
  UpdateProductData,
} from './types.js';

interface ProductRecord extends Omit<ProductDto, 'unitPrice'> {
  readonly unitPrice: { toString(): string } | string | number;
  readonly deletedAt: Date | null;
}

type ProductsTransaction = Pick<PrismaTransaction, 'auditLog' | 'product'>;
export type ProductsDatabase = Pick<PrismaDatabase, '$transaction' | 'product'>;

export interface ProductsService {
  list(access: ProductAccess, query: ProductListQuery): Promise<ProductListResult>;
  getById(access: ProductAccess, id: string): Promise<ProductDto>;
  create(access: ProductAccess, data: CreateProductData): Promise<ProductDto>;
  update(access: ProductAccess, id: string, data: UpdateProductData): Promise<ProductDto>;
  delete(access: ProductAccess, id: string, version: number): Promise<void>;
}

export const productSelection = {
  id: true,
  sku: true,
  name: true,
  description: true,
  category: true,
  unitPrice: true,
  currency: true,
  isActive: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
};

const toDto = ({ unitPrice, deletedAt: _deletedAt, ...product }: ProductRecord): ProductDto => ({
  ...product,
  unitPrice: unitPrice.toString(),
});

const assertUnitPrice = (unitPrice: string): void => {
  const numeric = Number(unitPrice);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new AppError('Unit price must be non-negative', 400, 'INVALID_PRODUCT_PRICE');
  }
};

/**
 * Defence in depth for the immutability rule: the request schema already omits
 * `sku`, so reaching this branch means the service was called directly.
 */
const assertSkuUnchanged = (data: UpdateProductData): void => {
  if ('sku' in data) {
    throw new AppError('SKU cannot be changed after creation', 400, 'PRODUCT_SKU_IMMUTABLE');
  }
};

const isRecordNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';

const concurrentModification = (): AppError =>
  new AppError('Product was modified by another request', 409, 'PRODUCT_CONCURRENT_MODIFICATION');

const assertCurrentVersion = (actual: number, expected: number): void => {
  if (actual !== expected) throw concurrentModification();
};

/**
 * The uniqueness of a SKU is decided by the database, never by a preceding
 * read: a check-then-insert would still lose a race with a concurrent create.
 */
const mapPersistenceError = (error: unknown): never => {
  if (isUniqueConstraintError(error)) {
    throw new AppError('A product with this SKU already exists', 409, 'PRODUCT_SKU_TAKEN');
  }
  throw error;
};

const findActive = async (
  store: ProductsTransaction['product'],
  id: string,
): Promise<ProductRecord> => {
  const product = await store.findFirst({
    where: { id, deletedAt: null },
    select: productSelection,
  });
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  return product;
};

export const createProductsService = (
  db: ProductsDatabase,
  audit: AuditService,
  // Secondary consumers (event stream, realtime channel) are notified only once
  // the transaction has committed, so they can never affect its outcome.
  events: DomainEventPublisher = noopDomainEventPublisher,
): ProductsService => {
  /**
   * The publisher contract forbids throwing, but the primary path is guarded
   * anyway: a change that is already committed must be reported as a success
   * even if a secondary consumer is misbehaving.
   */
  const announce = (event: DomainEventNotification): void => {
    try {
      events.publish(event);
    } catch {
      // Intentionally ignored; see above.
    }
  };

  const readPage = createListReader({ model: db.product, select: productSelection, toDto });

  return {
    async list(_access, query) {
      const where = filter<Prisma.ProductWhereInput>({ deletedAt: null })
        .equals('category', query.category)
        .equals('isActive', query.isActive)
        .search(query.search, ['name', 'sku'])
        .range('unitPrice', query.minPrice, query.maxPrice)
        .build();
      return readPage({
        where,
        page: query.page,
        pageSize: query.pageSize,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
      });
    },

    async getById(_access, id) {
      return toDto(await findActive(db.product, id));
    },

    async create(access, data) {
      assertUnitPrice(data.unitPrice);
      const created = await db.$transaction(async (transaction) => {
        let product: ProductRecord;
        try {
          product = await transaction.product.create({
            data: {
              sku: data.sku,
              name: data.name,
              description: data.description ?? null,
              category: data.category ?? null,
              unitPrice: data.unitPrice,
              currency: data.currency ?? 'USD',
              isActive: data.isActive ?? true,
            },
            select: productSelection,
          });
        } catch (error) {
          return mapPersistenceError(error);
        }
        const dto = toDto(product);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'product.created',
          entityType: 'product',
          entityId: product.id,
          changes: { after: dto },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return dto;
      });

      announce({
        eventType: 'product.created',
        entityType: 'product',
        entityId: created.id,
        actorId: access.actorId,
        payload: { after: created },
      });

      return created;
    },

    async update(access, id, data) {
      assertSkuUnchanged(data);
      if (data.unitPrice !== undefined) assertUnitPrice(data.unitPrice);
      const result = await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.product, id);
        assertCurrentVersion(existing.version, data.version);
        const updateData: Prisma.ProductUncheckedUpdateInput = {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.category !== undefined ? { category: data.category } : {}),
          ...(data.unitPrice !== undefined ? { unitPrice: data.unitPrice } : {}),
          ...(data.currency !== undefined ? { currency: data.currency } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          version: { increment: 1 },
        };
        let updated: ProductRecord;
        try {
          updated = await transaction.product.update({
            where: { id, version: data.version, deletedAt: null },
            data: updateData,
            select: productSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          return mapPersistenceError(error);
        }
        const before = toDto(existing);
        const after = toDto(updated);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'product.updated',
          entityType: 'product',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      announce({
        eventType: 'product.updated',
        entityType: 'product',
        entityId: id,
        actorId: access.actorId,
        payload: result,
      });

      return result.after;
    },

    async delete(access, id, version) {
      await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.product, id);
        assertCurrentVersion(existing.version, version);
        const deletedAt = new Date();
        try {
          await transaction.product.update({
            where: { id, version, deletedAt: null },
            data: { deletedAt, version: { increment: 1 } },
            select: productSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'product.deleted',
          entityType: 'product',
          entityId: id,
          changes: { before: toDto(existing), after: { deletedAt, version: version + 1 } },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
      });

      announce({
        eventType: 'product.deleted',
        entityType: 'product',
        entityId: id,
        actorId: access.actorId,
        payload: { id },
      });
    },
  };
};
