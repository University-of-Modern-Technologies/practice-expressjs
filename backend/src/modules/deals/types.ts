import { z } from 'zod';

import {
  currencyCodeSchema,
  decimalStringSchema,
  versionNumberSchema,
} from '../../common/openapi/index.js';
import type { PermissionScope } from '../rbac/types.js';

export const dealStages = ['LEAD', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST'] as const;
export type DealStage = (typeof dealStages)[number];

export const dealStageSchema = z.enum(dealStages).meta({ id: 'DealStage' });

export const dealSchema = z
  .object({
    id: z.uuid(),
    ownerId: z.uuid(),
    contactId: z.uuid().nullable(),
    title: z.string(),
    stage: dealStageSchema,
    amount: decimalStringSchema,
    currency: currencyCodeSchema,
    probability: z.int().min(0).max(100),
    version: versionNumberSchema,
    expectedCloseDate: z.date().nullable(),
    closedAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'Deal' });

export type DealDto = Readonly<z.infer<typeof dealSchema>>;

export interface DealAccess {
  readonly actorId: string;
  readonly scope: PermissionScope;
  readonly ipAddress?: string;
}

export interface CreateDealData {
  readonly ownerId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly title: string;
  readonly stage?: 'LEAD' | undefined;
  readonly amount: string;
  readonly currency?: string | undefined;
  readonly probability?: number | undefined;
  readonly expectedCloseDate?: string | undefined;
}

export interface UpdateDealData {
  readonly version: number;
  readonly ownerId?: string | undefined;
  readonly contactId?: string | null | undefined;
  readonly title?: string | undefined;
  readonly amount?: string | undefined;
  readonly currency?: string | undefined;
  readonly probability?: number | undefined;
  readonly expectedCloseDate?: string | null | undefined;
}

export interface TransitionDealData {
  readonly version: number;
  readonly stage: DealStage;
  readonly probability?: number | undefined;
}

export const dealSortFields = [
  'createdAt',
  'updatedAt',
  'title',
  'amount',
  'probability',
  'expectedCloseDate',
] as const;
export type DealSortField = (typeof dealSortFields)[number];

export interface DealListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly stage?: DealStage | undefined;
  readonly minAmount?: string | undefined;
  readonly maxAmount?: string | undefined;
  readonly minProbability?: number | undefined;
  readonly maxProbability?: number | undefined;
  readonly expectedCloseFrom?: string | undefined;
  readonly expectedCloseTo?: string | undefined;
  readonly sortBy: DealSortField;
  readonly sortOrder: 'asc' | 'desc';
}

export interface DealListResult {
  readonly items: readonly DealDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
