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
  AdjustStockInput,
  CreateWarehouseData,
  IssueStockInput,
  MovementListQuery,
  MovementListResult,
  ReceiveStockInput,
  ReleaseStockInput,
  ReserveStockInput,
  StockLevelDto,
  StockListQuery,
  StockListResult,
  StockMovementDto,
  StockMovementType,
  UpdateWarehouseData,
  WarehouseAccess,
  WarehouseDto,
  WarehouseListQuery,
  WarehouseListResult,
} from './types.js';

export type WarehouseTransaction = Pick<
  PrismaTransaction,
  'auditLog' | 'warehouse' | 'stockLevel' | 'stockMovement'
>;

export type WarehouseDatabase = Pick<
  PrismaDatabase,
  '$transaction' | 'warehouse' | 'stockLevel' | 'stockMovement'
>;

/**
 * The stock side of the module, isolated from warehouse administration so that
 * another module (order fulfilment, for instance) can depend on exactly these
 * five operations without reaching into warehouse CRUD. Every one of them is a
 * single committed transaction: a movement row plus the matching stock level.
 */
export interface StockOperations {
  receive(access: WarehouseAccess, input: ReceiveStockInput): Promise<StockLevelDto>;
  issue(access: WarehouseAccess, input: IssueStockInput): Promise<StockLevelDto>;
  reserve(access: WarehouseAccess, input: ReserveStockInput): Promise<StockLevelDto>;
  release(access: WarehouseAccess, input: ReleaseStockInput): Promise<StockLevelDto>;
  adjust(access: WarehouseAccess, input: AdjustStockInput): Promise<StockLevelDto>;
}

/**
 * The outcome of a movement that was applied on a transaction supplied by the
 * caller. The stock level is returned exactly as the committing variant returns
 * it; the domain event is *not* published yet, because the surrounding
 * transaction has not committed and may still roll back.
 */
export interface StockChangeInTransaction {
  readonly level: StockLevelDto;
  readonly movement: StockMovementDto;
  /**
   * Publishes the movement's domain event. The caller must invoke it only after
   * the transaction it supplied has committed, which keeps the after-commit
   * publishing rule intact for movements that another module drives.
   */
  readonly publishCommitted: () => void;
}

/**
 * The same five stock operations, but running on a transaction the caller owns.
 * This is what a module such as orders depends on when a stock change and its
 * own write have to succeed or fail together: both run inside one transaction,
 * so a short stock level rolls the caller's write back as well.
 */
export interface StockOperationsInTransaction {
  receive(
    transaction: WarehouseTransaction,
    access: WarehouseAccess,
    input: ReceiveStockInput,
  ): Promise<StockChangeInTransaction>;
  issue(
    transaction: WarehouseTransaction,
    access: WarehouseAccess,
    input: IssueStockInput,
  ): Promise<StockChangeInTransaction>;
  reserve(
    transaction: WarehouseTransaction,
    access: WarehouseAccess,
    input: ReserveStockInput,
  ): Promise<StockChangeInTransaction>;
  release(
    transaction: WarehouseTransaction,
    access: WarehouseAccess,
    input: ReleaseStockInput,
  ): Promise<StockChangeInTransaction>;
  adjust(
    transaction: WarehouseTransaction,
    access: WarehouseAccess,
    input: AdjustStockInput,
  ): Promise<StockChangeInTransaction>;
}

export interface WarehouseService extends StockOperations {
  listWarehouses(access: WarehouseAccess, query: WarehouseListQuery): Promise<WarehouseListResult>;
  getWarehouse(access: WarehouseAccess, id: string): Promise<WarehouseDto>;
  createWarehouse(access: WarehouseAccess, data: CreateWarehouseData): Promise<WarehouseDto>;
  updateWarehouse(
    access: WarehouseAccess,
    id: string,
    data: UpdateWarehouseData,
  ): Promise<WarehouseDto>;
  listStock(access: WarehouseAccess, query: StockListQuery): Promise<StockListResult>;
  getStock(access: WarehouseAccess, warehouseId: string, productId: string): Promise<StockLevelDto>;
  listMovements(access: WarehouseAccess, query: MovementListQuery): Promise<MovementListResult>;
}

interface WarehouseRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface StockLevelRecord {
  readonly id: string;
  readonly warehouseId: string;
  readonly productId: string;
  readonly quantityOnHand: number;
  readonly quantityReserved: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface MovementRecord {
  readonly id: string;
  readonly warehouseId: string;
  readonly productId: string;
  readonly type: StockMovementType;
  readonly quantity: number;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
  readonly actorId: string | null;
  readonly note: string | null;
  readonly createdAt: Date;
}

const warehouseSelection = {
  id: true,
  code: true,
  name: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
};

const stockLevelSelection = {
  id: true,
  warehouseId: true,
  productId: true,
  quantityOnHand: true,
  quantityReserved: true,
  version: true,
  createdAt: true,
  updatedAt: true,
};

const movementSelection = {
  id: true,
  warehouseId: true,
  productId: true,
  type: true,
  quantity: true,
  referenceType: true,
  referenceId: true,
  actorId: true,
  note: true,
  createdAt: true,
};

const toWarehouseDto = (record: WarehouseRecord): WarehouseDto => ({ ...record });

/** `quantityAvailable` is computed here and never stored, so it cannot drift. */
const toStockDto = (record: StockLevelRecord): StockLevelDto => ({
  ...record,
  quantityAvailable: record.quantityOnHand - record.quantityReserved,
});

const toMovementDto = (record: MovementRecord): StockMovementDto => ({ ...record });

const hasPrismaCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

/** The row that the conditional update targeted no longer matches. */
const isRecordNotFoundError = (error: unknown): boolean => hasPrismaCode(error, 'P2025');

const isUniqueConstraintError = (error: unknown): boolean => hasPrismaCode(error, 'P2002');

const isForeignKeyError = (error: unknown): boolean => hasPrismaCode(error, 'P2003');

const stockCheckConstraints = [
  'stock_levels_quantities_non_negative_check',
  'stock_levels_reserved_within_on_hand_check',
  'stock_levels_version_positive_check',
  'stock_movements_quantity_positive_check',
] as const;

const errorText = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return '';
  const parts: string[] = [];
  if ('message' in error && typeof error.message === 'string') parts.push(error.message);
  if ('meta' in error && typeof error.meta === 'object' && error.meta !== null) {
    parts.push(JSON.stringify(error.meta));
  }
  return parts.join(' ');
};

/**
 * The arithmetic guards below already reject an oversell before anything is
 * written, but the database CHECK constraints remain the last line of defence
 * against a path nobody anticipated. When one of them fires the request is
 * still a business conflict, not a server fault, so it is reported as the very
 * same 409 the in-code guard would have produced.
 */
const isStockCheckViolation = (error: unknown): boolean => {
  // Prisma reports a violated database constraint as P2004; some driver paths
  // surface only the raw PostgreSQL SQLSTATE (23514) or the constraint name.
  if (hasPrismaCode(error, 'P2004')) return true;
  const text = errorText(error);
  if (text.includes('23514')) return true;
  return stockCheckConstraints.some((constraint) => text.includes(constraint));
};

const insufficientStock = (): AppError =>
  new AppError('Not enough stock available for this operation', 409, 'INSUFFICIENT_STOCK');

const insufficientReservation = (): AppError =>
  new AppError('Not enough reserved stock for this operation', 409, 'INSUFFICIENT_RESERVATION');

const stockConflict = (): AppError =>
  new AppError(
    'Stock level was modified by another request; retry the operation',
    409,
    'STOCK_CONCURRENT_MODIFICATION',
  );

const mapStockWriteError = (error: unknown): never => {
  if (isRecordNotFoundError(error) || isUniqueConstraintError(error)) throw stockConflict();
  if (isStockCheckViolation(error)) {
    // `quantity_reserved >= 0` is the reservation guard; every other stock
    // CHECK describes units that are simply not there.
    throw errorText(error).includes('quantity_reserved >= 0')
      ? insufficientReservation()
      : insufficientStock();
  }
  if (isForeignKeyError(error)) {
    // The warehouse is verified before the write, so a failing foreign key can
    // only be the product reference.
    throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  }
  throw error;
};

const toDate = (value: string): Date => new Date(value);

/** Describes one stock change; the deltas are what the guards reason about. */
interface MovementPlan {
  readonly type: StockMovementType;
  readonly eventType: string;
  readonly warehouseId: string;
  readonly productId: string;
  /** Always positive: the database rejects a movement of zero or fewer units. */
  readonly quantity: number;
  readonly onHandDelta: number;
  readonly reservedDelta: number;
  readonly referenceType?: string | undefined;
  readonly referenceId?: string | undefined;
  readonly note?: string | undefined;
}

/**
 * Rejects every impossible outcome before a single row is touched. The order is
 * deliberate: a negative reservation is reported as a reservation problem, while
 * anything that would leave reserved units without stock behind them is an
 * oversell.
 */
const assertPlanIsSatisfiable = (
  current: Pick<StockLevelRecord, 'quantityOnHand' | 'quantityReserved'>,
  plan: MovementPlan,
): { readonly quantityOnHand: number; readonly quantityReserved: number } => {
  const quantityOnHand = current.quantityOnHand + plan.onHandDelta;
  const quantityReserved = current.quantityReserved + plan.reservedDelta;
  if (quantityReserved < 0) throw insufficientReservation();
  if (quantityOnHand < 0) throw insufficientStock();
  if (quantityReserved > quantityOnHand) throw insufficientStock();
  return { quantityOnHand, quantityReserved };
};

const receivePlan = (input: ReceiveStockInput): MovementPlan => ({
  type: 'RECEIPT',
  eventType: 'stock.received',
  warehouseId: input.warehouseId,
  productId: input.productId,
  quantity: input.quantity,
  onHandDelta: input.quantity,
  reservedDelta: 0,
  referenceType: input.referenceType,
  referenceId: input.referenceId,
  note: input.note,
});

const issuePlan = (input: IssueStockInput): MovementPlan => {
  // An issue that consumes a reservation frees the reserved units in the same
  // statement; without that the row would breach the database rule that
  // reserved units can never exceed the units on hand.
  const releasesReservation = input.fromReservation === true;
  return {
    type: 'ISSUE',
    eventType: 'stock.issued',
    warehouseId: input.warehouseId,
    productId: input.productId,
    quantity: input.quantity,
    onHandDelta: -input.quantity,
    reservedDelta: releasesReservation ? -input.quantity : 0,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    note: input.note,
  };
};

const reservePlan = (input: ReserveStockInput): MovementPlan => ({
  type: 'RESERVATION',
  eventType: 'stock.reserved',
  warehouseId: input.warehouseId,
  productId: input.productId,
  quantity: input.quantity,
  onHandDelta: 0,
  reservedDelta: input.quantity,
  referenceType: input.referenceType,
  referenceId: input.referenceId,
  note: input.note,
});

const releasePlan = (input: ReleaseStockInput): MovementPlan => ({
  type: 'RELEASE',
  eventType: 'stock.released',
  warehouseId: input.warehouseId,
  productId: input.productId,
  quantity: input.quantity,
  onHandDelta: 0,
  reservedDelta: -input.quantity,
  referenceType: input.referenceType,
  referenceId: input.referenceId,
  note: input.note,
});

/** Rejects a correction that records nothing or explains nothing before any row is read. */
const adjustPlan = (input: AdjustStockInput): MovementPlan => {
  if (input.delta === 0) {
    throw new AppError('Adjustment delta must not be zero', 400, 'INVALID_STOCK_ADJUSTMENT');
  }
  const note = input.note.trim();
  if (note.length === 0) {
    throw new AppError('Adjustment requires a note', 400, 'STOCK_ADJUSTMENT_NOTE_REQUIRED');
  }
  return {
    type: 'ADJUSTMENT',
    eventType: 'stock.adjusted',
    warehouseId: input.warehouseId,
    productId: input.productId,
    quantity: Math.abs(input.delta),
    onHandDelta: input.delta,
    reservedDelta: 0,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    note,
  };
};

const findWarehouse = async (
  store: WarehouseTransaction['warehouse'],
  id: string,
): Promise<WarehouseRecord> => {
  const warehouse = await store.findUnique({ where: { id }, select: warehouseSelection });
  if (!warehouse) throw new AppError('Warehouse not found', 404, 'WAREHOUSE_NOT_FOUND');
  return warehouse;
};

const assertWritableWarehouse = async (
  transaction: WarehouseTransaction,
  warehouseId: string,
): Promise<void> => {
  const warehouse = await findWarehouse(transaction.warehouse, warehouseId);
  if (!warehouse.isActive) {
    throw new AppError('Warehouse is deactivated', 409, 'WAREHOUSE_INACTIVE');
  }
};

interface MovementOutcome {
  readonly before: StockLevelDto | null;
  readonly after: StockLevelDto;
  readonly movement: StockMovementDto;
}

/**
 * Applies one movement on the supplied transaction: the guards, the conditional
 * version update, the movement row and the audit entry. It never opens a
 * transaction of its own, so it works equally well for a stock request that
 * stands alone and for one that has to commit together with another module's
 * write.
 *
 * The stock level is written with a conditional update on `version`. A plain
 * read-then-write is unsafe here: two requests can both read
 * `quantityReserved = 0` against 5 units on hand, both conclude that 5 units are
 * available, and both write `quantityReserved = 5` — the second write silently
 * overwrites the first and the same five units end up promised twice. Pinning
 * the update to the version that was read turns the second write into a no-op
 * that Prisma reports as P2025, which is translated into a retryable 409
 * instead of a lost update.
 */
const applyMovementInTransaction = async (
  transaction: WarehouseTransaction,
  audit: AuditService,
  access: WarehouseAccess,
  plan: MovementPlan,
): Promise<MovementOutcome> => {
  await assertWritableWarehouse(transaction, plan.warehouseId);

  const existing = await transaction.stockLevel.findUnique({
    where: {
      warehouseId_productId: { warehouseId: plan.warehouseId, productId: plan.productId },
    },
    select: stockLevelSelection,
  });

  // A pair that has never been stocked behaves exactly like an empty one, so the
  // guards below reject an issue or a reservation against it without creating
  // anything.
  const current = existing ?? { quantityOnHand: 0, quantityReserved: 0 };
  const next = assertPlanIsSatisfiable(current, plan);

  let after: StockLevelRecord;
  try {
    after = existing
      ? await transaction.stockLevel.update({
          where: { id: existing.id, version: existing.version },
          data: {
            quantityOnHand: next.quantityOnHand,
            quantityReserved: next.quantityReserved,
            version: { increment: 1 },
          },
          select: stockLevelSelection,
        })
      : await transaction.stockLevel.create({
          data: {
            warehouseId: plan.warehouseId,
            productId: plan.productId,
            quantityOnHand: next.quantityOnHand,
            quantityReserved: next.quantityReserved,
          },
          select: stockLevelSelection,
        });
  } catch (error) {
    // Creating the very first row for a pair races against every other first
    // movement for that pair. The unique index picks a winner and the loser sees
    // P2002; the failed statement has already aborted this transaction, so the
    // only safe answer is the same retryable 409 the version guard produces
    // rather than an in-place recovery attempt.
    return mapStockWriteError(error);
  }

  let movement: MovementRecord;
  try {
    movement = await transaction.stockMovement.create({
      data: {
        warehouseId: plan.warehouseId,
        productId: plan.productId,
        type: plan.type,
        quantity: plan.quantity,
        referenceType: plan.referenceType ?? null,
        referenceId: plan.referenceId ?? null,
        actorId: access.actorId,
        note: plan.note ?? null,
      },
      select: movementSelection,
    });
  } catch (error) {
    return mapStockWriteError(error);
  }

  const before = existing ? toStockDto(existing) : null;
  const afterDto = toStockDto(after);
  await audit.record(transaction, {
    actorId: access.actorId,
    action: plan.eventType,
    entityType: 'stock',
    entityId: after.id,
    changes: { before, after: afterDto },
    metadata: {
      movementId: movement.id,
      type: plan.type,
      quantity: plan.quantity,
      referenceType: plan.referenceType ?? null,
      referenceId: plan.referenceId ?? null,
    },
    ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
  });

  return { before, after: afterDto, movement: toMovementDto(movement) };
};

/**
 * The publisher contract forbids throwing, but every caller is guarded anyway: a
 * movement that is already committed must be reported as a success even if a
 * secondary consumer misbehaves.
 */
const createAnnouncer =
  (events: DomainEventPublisher) =>
  (event: DomainEventNotification): void => {
    try {
      events.publish(event);
    } catch {
      // Intentionally ignored; see above.
    }
  };

const movementEvent = (
  access: WarehouseAccess,
  plan: MovementPlan,
  outcome: MovementOutcome,
): DomainEventNotification => ({
  eventType: plan.eventType,
  entityType: 'stock',
  entityId: outcome.after.id,
  actorId: access.actorId,
  payload: { before: outcome.before, after: outcome.after, movement: outcome.movement },
});

/**
 * Builds the transaction-scoped stock port. It holds no database handle at all:
 * every operation runs on the transaction its caller passes in, and the caller
 * decides when the resulting event is published by invoking `publishCommitted`
 * once that transaction has committed.
 */
export const createStockOperationsInTransaction = (
  audit: AuditService,
  events: DomainEventPublisher = noopDomainEventPublisher,
): StockOperationsInTransaction => {
  const announce = createAnnouncer(events);

  const apply = async (
    transaction: WarehouseTransaction,
    access: WarehouseAccess,
    plan: MovementPlan,
  ): Promise<StockChangeInTransaction> => {
    const outcome = await applyMovementInTransaction(transaction, audit, access, plan);
    return {
      level: outcome.after,
      movement: outcome.movement,
      publishCommitted: () => {
        announce(movementEvent(access, plan, outcome));
      },
    };
  };

  return {
    async receive(transaction, access, input) {
      return apply(transaction, access, receivePlan(input));
    },
    async issue(transaction, access, input) {
      return apply(transaction, access, issuePlan(input));
    },
    async reserve(transaction, access, input) {
      return apply(transaction, access, reservePlan(input));
    },
    async release(transaction, access, input) {
      return apply(transaction, access, releasePlan(input));
    },
    async adjust(transaction, access, input) {
      return apply(transaction, access, adjustPlan(input));
    },
  };
};

export const createWarehouseService = (
  db: WarehouseDatabase,
  audit: AuditService,
  // Secondary consumers are notified only after the transaction has committed,
  // so a slow or broken listener can never roll back a stock change.
  events: DomainEventPublisher = noopDomainEventPublisher,
): WarehouseService => {
  const announce = createAnnouncer(events);

  const readWarehousePage = createListReader({
    model: db.warehouse,
    select: warehouseSelection,
    toDto: toWarehouseDto,
  });
  const readStockPage = createListReader({
    model: db.stockLevel,
    select: stockLevelSelection,
    toDto: toStockDto,
  });
  const readMovementPage = createListReader({
    model: db.stockMovement,
    select: movementSelection,
    toDto: toMovementDto,
  });

  /**
   * The self-contained variant of a movement: it opens the transaction, applies
   * the plan on it and publishes the event once that transaction has committed.
   */
  const applyMovement = async (
    access: WarehouseAccess,
    plan: MovementPlan,
  ): Promise<MovementOutcome> => {
    const result = await db.$transaction(async (transaction) =>
      applyMovementInTransaction(transaction, audit, access, plan),
    );

    // Only reached once the transaction has committed: a failed transaction
    // throws above and publishes nothing.
    announce(movementEvent(access, plan, result));

    return result;
  };

  return {
    async listWarehouses(_access, query) {
      const where = filter<Prisma.WarehouseWhereInput>()
        .equals('isActive', query.isActive)
        .search(query.search, ['code', 'name'])
        .build();
      return readWarehousePage({
        where,
        page: query.page,
        pageSize: query.pageSize,
        orderBy: [{ code: 'asc' }],
      });
    },

    async getWarehouse(_access, id) {
      return toWarehouseDto(await findWarehouse(db.warehouse, id));
    },

    async createWarehouse(access, data) {
      const created = await db.$transaction(async (transaction) => {
        let warehouse: WarehouseRecord;
        try {
          warehouse = await transaction.warehouse.create({
            data: { code: data.code, name: data.name, isActive: data.isActive ?? true },
            select: warehouseSelection,
          });
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new AppError(
              'A warehouse with this code already exists',
              409,
              'WAREHOUSE_CODE_TAKEN',
            );
          }
          throw error;
        }
        const dto = toWarehouseDto(warehouse);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'warehouse.created',
          entityType: 'warehouse',
          entityId: warehouse.id,
          changes: { after: dto },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return dto;
      });

      announce({
        eventType: 'warehouse.created',
        entityType: 'warehouse',
        entityId: created.id,
        actorId: access.actorId,
        payload: { after: created },
      });

      return created;
    },

    async updateWarehouse(access, id, data) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findWarehouse(transaction.warehouse, id);
        // The code identifies the warehouse in every movement ever recorded
        // against it, so it is fixed once the warehouse exists.
        if (data.code !== undefined && data.code !== existing.code) {
          throw new AppError(
            'Warehouse code cannot be changed after creation',
            400,
            'WAREHOUSE_CODE_IMMUTABLE',
          );
        }
        const updated = await transaction.warehouse.update({
          where: { id },
          data: {
            ...(data.name === undefined ? {} : { name: data.name }),
            ...(data.isActive === undefined ? {} : { isActive: data.isActive }),
          },
          select: warehouseSelection,
        });
        const before = toWarehouseDto(existing);
        const after = toWarehouseDto(updated);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'warehouse.updated',
          entityType: 'warehouse',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      announce({
        eventType: 'warehouse.updated',
        entityType: 'warehouse',
        entityId: id,
        actorId: access.actorId,
        payload: result,
      });

      return result.after;
    },

    async listStock(_access, query) {
      // Available stock is derived and therefore not indexable; the low-stock
      // filter works on the stored on-hand quantity, and only ever bounds it
      // from above.
      const where = filter<Prisma.StockLevelWhereInput>()
        .equals('warehouseId', query.warehouseId)
        .equals('productId', query.productId)
        .range('quantityOnHand', undefined, query.lowStockThreshold)
        .build();
      return readStockPage({
        where,
        page: query.page,
        pageSize: query.pageSize,
        orderBy: [{ quantityOnHand: 'asc' }, { id: 'asc' }],
      });
    },

    async getStock(_access, warehouseId, productId) {
      const level = await db.stockLevel.findUnique({
        where: { warehouseId_productId: { warehouseId, productId } },
        select: stockLevelSelection,
      });
      if (!level) throw new AppError('Stock level not found', 404, 'STOCK_LEVEL_NOT_FOUND');
      return toStockDto(level);
    },

    async listMovements(_access, query) {
      const where = filter<Prisma.StockMovementWhereInput>()
        .equals('warehouseId', query.warehouseId)
        .equals('productId', query.productId)
        .equals('type', query.type)
        .equals('referenceType', query.referenceType)
        .equals('referenceId', query.referenceId)
        .range('createdAt', query.createdFrom, query.createdTo, toDate)
        .build();
      return readMovementPage({
        where,
        page: query.page,
        pageSize: query.pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    },

    async receive(access, input) {
      const { after } = await applyMovement(access, receivePlan(input));
      return after;
    },

    async issue(access, input) {
      const { after } = await applyMovement(access, issuePlan(input));
      return after;
    },

    async reserve(access, input) {
      const { after } = await applyMovement(access, reservePlan(input));
      return after;
    },

    async release(access, input) {
      const { after } = await applyMovement(access, releasePlan(input));
      return after;
    },

    async adjust(access, input) {
      // The plan builder rejects a zero delta or a blank note before the
      // transaction is opened, exactly as this method always has.
      const { after } = await applyMovement(access, adjustPlan(input));
      return after;
    },
  };
};
