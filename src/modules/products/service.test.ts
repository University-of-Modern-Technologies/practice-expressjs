import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import type { DomainEventNotification, DomainEventPublisher } from '../../common/types/index.js';
import type { AuditService } from '../audit/service.js';
import { createProductsService, type ProductsDatabase } from './service.js';
import type { ProductAccess, UpdateProductData } from './types.js';

const access: ProductAccess = { actorId: 'actor-1', scope: 'ALL' };
const timestamp = new Date('2026-01-01T00:00:00Z');

const activeProduct = {
  id: 'product-1',
  sku: 'SKU-1',
  name: 'Widget',
  description: null,
  category: 'hardware',
  unitPrice: '19.99',
  currency: 'USD',
  isActive: true,
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
};

interface HarnessOptions {
  readonly create?: (args: unknown) => Promise<unknown>;
  readonly update?: (args: unknown) => Promise<unknown>;
}

const createHarness = (options: HarnessOptions = {}) => {
  const findFirst = jest.fn(async (_args: unknown) => activeProduct);
  const createProduct = jest.fn(options.create ?? (async (_args: unknown) => activeProduct));
  const updateProduct = jest.fn(
    options.update ?? (async (_args: unknown) => ({ ...activeProduct, version: 2 })),
  );
  const transaction = {
    product: { findFirst, create: createProduct, update: updateProduct },
    auditLog: { create: jest.fn() },
  };
  const findMany = jest.fn(async (_args: unknown) => [activeProduct]);
  const count = jest.fn(async (_args: unknown) => 1);
  const db = {
    product: { findFirst, findMany, count },
    $transaction: jest.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as ProductsDatabase;
  const record = jest.fn(async () => undefined);
  const audit = { record } as unknown as AuditService;
  const publish = jest.fn((_event: DomainEventNotification): void => undefined);
  const events: DomainEventPublisher = { publish };

  return {
    service: createProductsService(db, audit, events),
    db,
    findFirst,
    findMany,
    createProduct,
    updateProduct,
    record,
    publish,
  };
};

const validProduct = { sku: 'SKU-1', name: 'Widget', unitPrice: '19.99' };

describe('products service catalogue rules', () => {
  it('lets the database decide about SKU uniqueness and reports it as a conflict', async () => {
    const harness = createHarness({
      create: async () => {
        throw { code: 'P2002', meta: { target: ['sku'] } };
      },
    });

    await expect(harness.service.create(access, validProduct)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_SKU_TAKEN',
    } satisfies Partial<AppError>);
    // No read precedes the insert: a check-then-insert would lose the race.
    expect(harness.findFirst).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('creates an active product with the defaults applied', async () => {
    const harness = createHarness();

    const created = await harness.service.create(access, validProduct);

    expect(harness.createProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sku: 'SKU-1',
          currency: 'USD',
          isActive: true,
          description: null,
        }) as unknown,
      }),
    );
    expect(created.unitPrice).toBe('19.99');
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'product.created', entityType: 'product' }),
    );
  });

  it('refuses a negative price even if validation is bypassed', async () => {
    const harness = createHarness();

    await expect(
      harness.service.create(access, { ...validProduct, unitPrice: '-1.00' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_PRODUCT_PRICE' });
    expect(harness.db.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to change the SKU of an existing product', async () => {
    const harness = createHarness();
    const data = { version: 1, sku: 'SKU-2' } as unknown as UpdateProductData;

    await expect(harness.service.update(access, activeProduct.id, data)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PRODUCT_SKU_IMMUTABLE',
    });
    expect(harness.updateProduct).not.toHaveBeenCalled();
  });

  it('searches by name or sku and honours the active filter', async () => {
    const harness = createHarness();

    await harness.service.list(access, {
      page: 1,
      pageSize: 20,
      search: 'wid',
      isActive: false,
      sortBy: 'name',
      sortOrder: 'asc',
    });

    expect(harness.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          isActive: false,
          OR: [
            { name: { contains: 'wid', mode: 'insensitive' } },
            { sku: { contains: 'wid', mode: 'insensitive' } },
          ],
        }) as unknown,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    );
  });
});

describe('products service optimistic concurrency', () => {
  it('rejects a stale update before writing', async () => {
    const harness = createHarness();

    await expect(
      harness.service.update(access, activeProduct.id, { version: 2, name: 'Gadget' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_CONCURRENT_MODIFICATION' });
    expect(harness.updateProduct).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('guards the write by the previously read version and increments it', async () => {
    const harness = createHarness();

    const updated = await harness.service.update(access, activeProduct.id, {
      version: 1,
      name: 'Gadget',
    });

    expect(updated.version).toBe(2);
    expect(harness.updateProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: activeProduct.id, version: 1, deletedAt: null },
        data: expect.objectContaining({ name: 'Gadget', version: { increment: 1 } }) as unknown,
      }),
    );
    expect(harness.record).toHaveBeenCalledTimes(1);
  });

  it('turns a lost race into a conflict and skips the audit trail', async () => {
    const harness = createHarness({
      update: async () => {
        throw { code: 'P2025' };
      },
    });

    await expect(
      harness.service.update(access, activeProduct.id, { version: 1, name: 'Gadget' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_CONCURRENT_MODIFICATION' });
    expect(harness.record).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('soft-deletes under the same version predicate', async () => {
    const harness = createHarness();

    await harness.service.delete(access, activeProduct.id, 1);

    expect(harness.updateProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: activeProduct.id, version: 1, deletedAt: null },
        data: expect.objectContaining({
          deletedAt: expect.any(Date) as unknown as Date,
          version: { increment: 1 },
        }) as unknown,
      }),
    );
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'product.deleted' }),
    );
  });

  it('reports a missing or already deleted product as not found', async () => {
    const harness = createHarness();
    harness.findFirst.mockImplementation(async () => null as unknown as typeof activeProduct);

    await expect(harness.service.getById(access, 'missing')).rejects.toMatchObject({
      statusCode: 404,
      code: 'PRODUCT_NOT_FOUND',
    });
  });
});

describe('products service domain event fan-out', () => {
  it('stays silent when the transaction fails', async () => {
    const harness = createHarness({
      create: async () => {
        throw { code: 'P2002' };
      },
    });

    await expect(harness.service.create(access, validProduct)).rejects.toBeInstanceOf(AppError);
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('keeps the business result when a secondary consumer fails', async () => {
    const harness = createHarness();
    harness.publish.mockImplementation(() => {
      throw new Error('event stream unreachable');
    });

    await expect(harness.service.create(access, validProduct)).resolves.toMatchObject({
      id: activeProduct.id,
    });
  });
});
