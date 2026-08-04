import type { PermissionScope } from '../rbac/types.js';

export interface ProductDto {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly unitPrice: string;
  readonly currency: string;
  readonly isActive: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The catalogue has no owner column, so `scope` only decides whether the actor
 * may touch products at all; unlike deals it never narrows the result set.
 */
export interface ProductAccess {
  readonly actorId: string;
  readonly scope: PermissionScope;
  readonly ipAddress?: string;
}

export interface CreateProductData {
  readonly sku: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly category?: string | undefined;
  readonly unitPrice: string;
  readonly currency?: string | undefined;
  readonly isActive?: boolean | undefined;
}

/** `sku` is deliberately absent: it is immutable once the product exists. */
export interface UpdateProductData {
  readonly version: number;
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly category?: string | null | undefined;
  readonly unitPrice?: string | undefined;
  readonly currency?: string | undefined;
  readonly isActive?: boolean | undefined;
}

export const productSortFields = [
  'createdAt',
  'updatedAt',
  'name',
  'sku',
  'unitPrice',
  'category',
] as const;
export type ProductSortField = (typeof productSortFields)[number];

export interface ProductListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | undefined;
  readonly category?: string | undefined;
  readonly isActive?: boolean | undefined;
  readonly minPrice?: string | undefined;
  readonly maxPrice?: string | undefined;
  readonly sortBy: ProductSortField;
  readonly sortOrder: 'asc' | 'desc';
}

export interface ProductListResult {
  readonly items: readonly ProductDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
