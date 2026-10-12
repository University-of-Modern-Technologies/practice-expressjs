import { loadConfig } from './env.js';

const source = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgresql://crm:crm@127.0.0.1:5432/crm_test?schema=public',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MONGODB_URL: 'mongodb://127.0.0.1:27017/events_test',
  JWT_ACCESS_SECRET: 'test-access-secret-with-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-with-at-least-32-characters',
  ...overrides,
});

describe('loadConfig', () => {
  it('listens on 8000 when no port is given', () => {
    expect(loadConfig(source()).port).toBe(8000);
  });

  it('takes the shared API_PORT when PORT is not set', () => {
    expect(loadConfig(source({ API_PORT: '8100' })).port).toBe(8100);
  });

  it('lets PORT win over API_PORT', () => {
    expect(loadConfig(source({ PORT: '8200', API_PORT: '8100' })).port).toBe(8200);
  });

  it('reads the environment from APP_ENV', () => {
    expect(loadConfig(source()).appEnv).toBe('development');
    expect(loadConfig(source({ APP_ENV: 'production', NODE_ENV: 'test' })).appEnv).toBe(
      'production',
    );
  });

  it('rejects an unknown APP_ENV', () => {
    expect(() => loadConfig(source({ APP_ENV: 'staging' }))).toThrow(/APP_ENV/);
  });

  it('names a storage URL that could not be assembled', () => {
    const withoutDatabase = source();
    delete withoutDatabase.DATABASE_URL;

    expect(() => loadConfig(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it('allows the web client origin by default', () => {
    expect(loadConfig(source()).corsOrigins).toEqual(['http://localhost:3000']);
  });
});
