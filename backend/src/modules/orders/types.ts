import { z } from 'zod';

import {
  currencyCodeSchema,
  decimalStringSchema,
  versionNumberSchema,
} from '../../common/openapi/index.js';
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

export const orderStatusSchema = z.enum(orderStatuses).meta({ id: 'OrderStatus' });

export const orderItemSchema = z
  .object({
    id: z.uuid(),
    orderId: z.uuid(),
    productId: z.uuid(),
    sku: z.string().meta({ description: 'Знімок каталогу на момент додавання рядка.' }),
    name: z.string(),
    quantity: z.int().min(1),
    unitPrice: decimalStringSchema,
    lineTotal: decimalStringSchema,
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'OrderItem' });

export type OrderItemDto = Readonly<z.infer<typeof orderItemSchema>>;

export const orderSchema = z
  .object({
    id: z.uuid(),
    orderNumber: z.string().meta({ description: 'Видається сервером.' }),
    ownerId: z.uuid(),
    contactId: z.uuid().nullable(),
    dealId: z.uuid().nullable(),
    status: orderStatusSchema,
    currency: currencyCodeSchema,
    subtotal: decimalStringSchema,
    discountTotal: decimalStringSchema,
    taxTotal: decimalStringSchema,
    total: decimalStringSchema.meta({
      description: 'Обчислюється сервером із рядків замовлення.',
    }),
    notes: z.string().nullable(),
    version: versionNumberSchema,
    placedAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    items: z.array(orderItemSchema),
  })
  .meta({ id: 'Order' });

export type OrderDto = Readonly<z.infer<typeof orderSchema>>;

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
