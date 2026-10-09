import { describe, expect, it } from '@jest/globals';

import { prismaLogLevels } from './prisma.js';

describe('prisma log levels', () => {
  it('does not log statements by default, not even in development', () => {
    expect(prismaLogLevels({ APP_ENV: 'development' })).not.toContain('query');
    expect(prismaLogLevels({ APP_ENV: 'test' })).not.toContain('query');
  });

  it('logs statements once LOG_SQL is on', () => {
    expect(prismaLogLevels({ APP_ENV: 'development', LOG_SQL: 'true' })).toContain('query');
    expect(prismaLogLevels({ APP_ENV: 'test', LOG_SQL: '1' })).toContain('query');
  });

  it('never logs statements in production', () => {
    expect(prismaLogLevels({ APP_ENV: 'production', LOG_SQL: 'true' })).toEqual(['warn', 'error']);
  });
});
