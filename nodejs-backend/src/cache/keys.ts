// Cache keys are built from colon-separated segments so that every feature owns
// a namespace and whole namespaces can be dropped with a single prefix scan.
export const CACHE_KEY_SEPARATOR = ':';

export const cacheKey = (...segments: readonly string[]): string =>
  segments.join(CACHE_KEY_SEPARATOR);

// A prefix always ends with the separator so that `rbac:user` never matches
// `rbac:users-something`.
export const cacheKeyPrefix = (...segments: readonly string[]): string =>
  `${cacheKey(...segments)}${CACHE_KEY_SEPARATOR}`;

export const RBAC_NAMESPACE = 'rbac';
export const USER_PERMISSIONS_NAMESPACE = 'user-permissions';

export const userPermissionsKey = (userId: string): string =>
  cacheKey(RBAC_NAMESPACE, USER_PERMISSIONS_NAMESPACE, userId);

export const userPermissionsPrefix = (): string =>
  cacheKeyPrefix(RBAC_NAMESPACE, USER_PERMISSIONS_NAMESPACE);
