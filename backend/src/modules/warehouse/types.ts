import { z } from 'zod';

import { versionNumberSchema } from '../../common/openapi/index.js';
import type { PermissionScope } from '../rbac/types.js';

/** Movement kinds, mirroring the `StockMovementType` enum stored in the database. */
export const stockMovementTypes = [
  'RECEIPT',
  'ISSUE',
  'RESERVATION',
  'RELEASE',
  'ADJUSTMENT',
] as const;
export type StockMovementType = (typeof stockMovementTypes)[number];

/** Resource name used to build the `warehouse:read` / `warehouse:write` keys. */
export const WAREHOUSE_RESOURCE = 'warehouse';

export const warehouseSchema = z
  .object({
    id: z.uuid(),
    code: z.string().max(32).meta({ description: 'Незмінний після створення.' }),
    name: z.string(),
    isActive: z.boolean(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'Warehouse' });

export type WarehouseDto = Readonly<z.infer<typeof warehouseSchema>>;

export const stockLevelSchema = z
  .object({
    id: z.uuid(),
    warehouseId: z.uuid(),
    productId: z.uuid(),
    quantityOnHand: z.int().min(0),
    quantityReserved: z.int().min(0),
    // Derived, never stored: what the next reservation is actually allowed to take.
    quantityAvailable: z
      .int()
      .min(0)
      .meta({ description: 'Похідне значення: quantityOnHand − quantityReserved.' }),
    version: versionNumberSchema,
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'StockLevel' });

export type StockLevelDto = Readonly<z.infer<typeof stockLevelSchema>>;

export const stockMovementTypeSchema = z.enum(stockMovementTypes).meta({ id: 'StockMovementType' });

export const stockMovementSchema = z
  .object({
    id: z.uuid(),
    warehouseId: z.uuid(),
    productId: z.uuid(),
    type: stockMovementTypeSchema,
    quantity: z.int(),
    referenceType: z.string().nullable(),
    referenceId: z.uuid().nullable(),
    actorId: z.uuid().nullable(),
    note: z.string().nullable(),
    createdAt: z.date(),
  })
  .meta({ id: 'StockMovement' });

export type StockMovementDto = Readonly<z.infer<typeof stockMovementSchema>>;

/**
 * Stock is organisation-wide: unlike deals or contacts there is no owner column
 * to narrow a query by, so an `OWN` grant sees exactly what an `ALL` grant sees.
 * The scope is still carried through so that a future per-warehouse ownership
 * model has a place to hook into, and so audit records keep the caller's grant.
 */
export interface WarehouseAccess {
  readonly actorId: string;
  readonly scope: PermissionScope;
  readonly ipAddress?: string;
}

export interface CreateWarehouseData {
  readonly code: string;
  readonly name: string;
  readonly isActive?: boolean | undefined;
}

export interface UpdateWarehouseData {
  /** Accepted only to be rejected when it differs: the code is immutable. */
  readonly code?: string | undefined;
  readonly name?: string | undefined;
  readonly isActive?: boolean | undefined;
}

export interface WarehouseListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | undefined;
  readonly isActive?: boolean | undefined;
}

export interface StockListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly warehouseId?: string | undefined;
  readonly productId?: string | undefined;
  /** Matches rows whose on-hand quantity has fallen to or below this value. */
  readonly lowStockThreshold?: number | undefined;
}

export interface MovementListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly warehouseId?: string | undefined;
  readonly productId?: string | undefined;
  readonly type?: StockMovementType | undefined;
  readonly referenceType?: string | undefined;
  readonly referenceId?: string | undefined;
  readonly createdFrom?: string | undefined;
  readonly createdTo?: string | undefined;
}

export interface PaginatedResult<TItem> {
  readonly items: readonly TItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export type WarehouseListResult = PaginatedResult<WarehouseDto>;
export type StockListResult = PaginatedResult<StockLevelDto>;
export type MovementListResult = PaginatedResult<StockMovementDto>;

interface StockTargetInput {
  readonly warehouseId: string;
  readonly productId: string;
}

export interface ReceiveStockInput extends StockTargetInput {
  readonly quantity: number;
  readonly referenceType?: string | undefined;
  readonly referenceId?: string | undefined;
  readonly note?: string | undefined;
}

export interface IssueStockInput extends StockTargetInput {
  readonly quantity: number;
  /**
   * When true the issue consumes an existing reservation, so the reserved
   * counter is released by the same amount in the very same statement.
   */
  readonly fromReservation?: boolean | undefined;
  readonly referenceType?: string | undefined;
  readonly referenceId?: string | undefined;
  readonly note?: string | undefined;
}

export interface ReserveStockInput extends StockTargetInput {
  readonly quantity: number;
  /** Reservations are always held on behalf of something; the reference is required. */
  readonly referenceType: string;
  readonly referenceId: string;
  readonly note?: string | undefined;
}

export type ReleaseStockInput = ReserveStockInput;

export interface AdjustStockInput extends StockTargetInput {
  /** Signed correction; zero is rejected because it would record nothing. */
  readonly delta: number;
  /** Mandatory: an inventory correction without a reason is not auditable. */
  readonly note: string;
  readonly referenceType?: string | undefined;
  readonly referenceId?: string | undefined;
}
