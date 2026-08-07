import { cacheKey, cacheKeyPrefix } from '../../cache/keys.js';

// Module-local key builders: the shared `keys.ts` only owns namespaces that
// more than one module needs, so the settings namespace lives here.
export const SETTINGS_NAMESPACE = 'settings';

export const settingValueKey = (key: string): string => cacheKey(SETTINGS_NAMESPACE, 'value', key);

export const settingsListKey = (): string => cacheKey(SETTINGS_NAMESPACE, 'list');

export const settingsPrefix = (): string => cacheKeyPrefix(SETTINGS_NAMESPACE);
