import { describe, expect, it } from '@jest/globals';

import {
  CACHE_KEY_SEPARATOR,
  cacheKey,
  cacheKeyPrefix,
  userPermissionsKey,
  userPermissionsPrefix,
} from './keys.js';

describe('cache keys', () => {
  it('joins segments with the shared separator', () => {
    expect(cacheKey('a', 'b', 'c')).toBe(`a${CACHE_KEY_SEPARATOR}b${CACHE_KEY_SEPARATOR}c`);
  });

  it('terminates prefixes with the separator', () => {
    expect(cacheKeyPrefix('a', 'b')).toBe('a:b:');
  });

  it('builds a namespaced user permissions key', () => {
    expect(userPermissionsKey('user-1')).toBe('rbac:user-permissions:user-1');
  });

  it('builds a prefix that matches every user permissions key', () => {
    const prefix = userPermissionsPrefix();
    expect(prefix).toBe('rbac:user-permissions:');
    expect(userPermissionsKey('user-1').startsWith(prefix)).toBe(true);
  });

  it('does not let one namespace prefix match a sibling namespace', () => {
    expect(cacheKey('rbac', 'user-permissions-archive', 'user-1')).not.toContain(
      userPermissionsPrefix(),
    );
  });
});
