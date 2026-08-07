import { z } from 'zod';

import { AppError } from '../../common/errors/app-error.js';

/**
 * The organization settings store is a closed set, not a free-form bucket: a
 * key exists only if it is declared here together with the schema its value
 * must satisfy and the default that applies while no row exists. Writing an
 * undeclared key is rejected, which keeps the table readable and lets other
 * modules depend on a value being present and well typed.
 */
export interface SettingDefinition<T> {
  readonly schema: z.ZodType<T>;
  readonly defaultValue: T;
  readonly description: string;
}

const defineSetting = <T>(
  schema: z.ZodType<T>,
  defaultValue: T,
  description: string,
): SettingDefinition<T> => ({ schema, defaultValue, description });

const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'Expected a three-letter currency code')
  .transform((value) => value.toUpperCase());

const shortCode = (max: number): z.ZodType<string> =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Expected an alphanumeric code')
    .max(max)
    .transform((value) => value.toUpperCase());

export const settingRegistry = {
  'organization.name': defineSetting(
    z.string().trim().min(1).max(120),
    'Training CRM',
    'Display name of the organization.',
  ),
  'organization.defaultCurrency': defineSetting(
    currencyCode,
    'USD',
    'Currency applied to new orders and deals.',
  ),
  'orders.numberPrefix': defineSetting(
    shortCode(8),
    'ORD',
    'Prefix used when generating order numbers.',
  ),
  'warehouse.defaultCode': defineSetting(
    shortCode(32),
    'CENTRAL',
    'Warehouse used when a request does not name one.',
  ),
};

export type SettingRegistry = typeof settingRegistry;
export type SettingKey = keyof SettingRegistry;

/** Value type declared for a key, derived from its registry schema. */
export type SettingValue<K extends SettingKey> =
  SettingRegistry[K] extends SettingDefinition<infer T> ? T : never;

export const settingKeys: readonly SettingKey[] = Object.keys(
  settingRegistry,
).sort() as SettingKey[];

export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(settingRegistry, key);

/** Narrows an arbitrary path segment to a declared key or rejects the request. */
export const ensureSettingKey = (key: string): SettingKey => {
  if (!isSettingKey(key)) {
    throw new AppError(`Unknown setting key: ${key}`, 400, 'UNKNOWN_SETTING_KEY', { key });
  }
  return key;
};

export const settingDefinition = <K extends SettingKey>(
  key: K,
): SettingDefinition<SettingValue<K>> =>
  settingRegistry[key] as unknown as SettingDefinition<SettingValue<K>>;

export const settingDefault = <K extends SettingKey>(key: K): SettingValue<K> =>
  settingDefinition(key).defaultValue;

/** Validates a candidate value against the schema declared for its own key. */
export const parseSettingValue = <K extends SettingKey>(
  key: K,
  value: unknown,
): SettingValue<K> => {
  const result = settingDefinition(key).schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      `Invalid value for setting ${key}`,
      400,
      'INVALID_SETTING_VALUE',
      z.flattenError(result.error),
    );
  }
  return result.data;
};

/**
 * Reads a value that is already stored. A row written before a schema was
 * tightened must not turn every read into a failure, so an unparsable stored
 * value degrades to the declared default instead of throwing.
 */
export const readStoredValue = <K extends SettingKey>(key: K, stored: unknown): SettingValue<K> => {
  const result = settingDefinition(key).schema.safeParse(stored);
  return result.success ? result.data : settingDefault(key);
};
