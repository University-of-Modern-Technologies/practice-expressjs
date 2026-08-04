import { describe, expect, it } from '@jest/globals';

import { AppError } from '../../common/errors/app-error.js';
import {
  ensureSettingKey,
  isSettingKey,
  parseSettingValue,
  readStoredValue,
  settingDefault,
  settingKeys,
} from './registry.js';

describe('settings registry', () => {
  it('declares every known key', () => {
    expect(settingKeys).toEqual([
      'orders.numberPrefix',
      'organization.defaultCurrency',
      'organization.name',
      'warehouse.defaultCode',
    ]);
  });

  it('accepts a value that matches the schema of its key', () => {
    expect(parseSettingValue('organization.name', '  Acme  ')).toBe('Acme');
    expect(parseSettingValue('organization.defaultCurrency', 'eur')).toBe('EUR');
    expect(parseSettingValue('orders.numberPrefix', 'inv')).toBe('INV');
    expect(parseSettingValue('warehouse.defaultCode', 'north-1')).toBe('NORTH-1');
  });

  it('rejects a value that does not match the schema of its key', () => {
    expect(() => parseSettingValue('organization.defaultCurrency', 'EURO')).toThrow(AppError);
    expect(() => parseSettingValue('organization.name', 42)).toThrow(AppError);
    expect(() => parseSettingValue('organization.name', '')).toThrow(AppError);

    try {
      parseSettingValue('organization.defaultCurrency', 'EURO');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_SETTING_VALUE');
      expect((error as AppError).statusCode).toBe(400);
    }
  });

  it('rejects an undeclared key instead of storing it', () => {
    expect(isSettingKey('organization.name')).toBe(true);
    expect(isSettingKey('organization.unknown')).toBe(false);

    try {
      ensureSettingKey('organization.unknown');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('UNKNOWN_SETTING_KEY');
      expect((error as AppError).statusCode).toBe(400);
      expect((error as AppError).details).toEqual({ key: 'organization.unknown' });
    }
  });

  it('does not treat inherited object properties as keys', () => {
    expect(isSettingKey('toString')).toBe(false);
    expect(isSettingKey('constructor')).toBe(false);
  });

  it('exposes a default for every key', () => {
    expect(settingDefault('organization.name')).toBe('Training CRM');
    expect(settingDefault('organization.defaultCurrency')).toBe('USD');
    expect(settingDefault('orders.numberPrefix')).toBe('ORD');
    expect(settingDefault('warehouse.defaultCode')).toBe('CENTRAL');
  });

  it('degrades a stored value that no longer parses to the default', () => {
    expect(readStoredValue('organization.name', 'Stored')).toBe('Stored');
    expect(readStoredValue('organization.name', { legacy: true })).toBe('Training CRM');
  });
});
