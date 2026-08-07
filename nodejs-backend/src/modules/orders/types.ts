import type { PermissionScope } from '../rbac/types.js';

export const orderStatuses = ['DRAFT', 'CONFIRMED', 'PAID', 'FULFILLED', 'CANCELLED'] as const;
export type OrderStatus = (typeof orderStatuses)[number];

/**
 * The three stock effects an order lifecycle can have. Declared alongside
 * `OrderStatus` — rather than in `stock.ts` — so that `state.ts` can describe
 * a status without importing the stock module, which would otherwise import
 * the state back to compute `stockEffectForTransition`.
 */
export type OrderStockEffect = 'reserve' | 'release' | 'issue';

export interface OrderItemDto {
  readonly id: string;
  readonly orderId: string;
  readonly productId: string;
  /** Snapshot of the catalogue entry taken when the line was added. */
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly lineTotal: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OrderDto {
  readonly id: string;
  readonly orderNumber: string;
  readonly ownerId: string;
  readonly contactId: string | null;
  readonly dealId: string | null;
  readonly status: OrderStatus;
  readonly currency: string;
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly total: string;
  readonly notes: string | null;
  readonly version: number;
  readonly placedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly items: readonly OrderItemDto[];
}

export interface OrderAccess {
  readonly actorId: string;
  readonly scope: PermissionScope;
  readonly ipAddress?: string;
}

export interface CreateOrderItemData {
  readonly productId: string;
  readonly quantity: number;
}

export interface CreateOrderData {
  readonly ownerId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly dealId?: string | undefined;
  readonly currency?: string | undefined;
  readonly discountTotal?: string | undefined;
  readonly taxTotal?: string | undefined;
  readonly notes?: string | undefined;
  readonly items?: readonly CreateOrderItemData[] | undefined;
}

/** `status`, `orderNumber` and the totals are server-owned and not accepted. */
export interface UpdateOrderData {
  readonly version: number;
  readonly ownerId?: string | undefined;
  readonly contactId?: string | null | undefined;
  readonly dealId?: string | null | undefined;
  readonly currency?: string | undefined;
  readonly discountTotal?: string | undefined;
  readonly taxTotal?: string | undefined;
  readonly notes?: string | null | undefined;
}

export interface AddOrderItemData {
  readonly version: number;
  readonly productId: string;
  readonly quantity: number;
}

export interface UpdateOrderItemData {
  readonly version: number;
  readonly quantity: number;
}

export interface TransitionOrderData {
  readonly version: number;
  readonly status: OrderStatus;
}

export const orderSortFields = [
  'createdAt',
  'updatedAt',
  'orderNumber',
  'total',
  'placedAt',
  'status',
] as const;
export type OrderSortField = (typeof orderSortFields)[number];

export interface OrderListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly dealId?: string | undefined;
  readonly status?: OrderStatus | undefined;
  readonly minTotal?: string | undefined;
  readonly maxTotal?: string | undefined;
  readonly sortBy: OrderSortField;
  readonly sortOrder: 'asc' | 'desc';
}

export interface OrderListResult {
  readonly items: readonly OrderDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
