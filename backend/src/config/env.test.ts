import { loadConfig, parseByteSize } from './env.js';

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

  it('serves the API description everywhere except production by default', () => {
    expect(loadConfig(source()).apiDocsEnabled).toBe(true);
    expect(loadConfig(source({ APP_ENV: 'test' })).apiDocsEnabled).toBe(true);
    expect(loadConfig(source({ APP_ENV: 'production' })).apiDocsEnabled).toBe(false);
  });

  it('lets API_DOCS_ENABLED override the default in either direction', () => {
    expect(
      loadConfig(source({ APP_ENV: 'production', API_DOCS_ENABLED: 'true' })).apiDocsEnabled,
    ).toBe(true);
    expect(loadConfig(source({ API_DOCS_ENABLED: 'false' })).apiDocsEnabled).toBe(false);
  });

  it('rejects an API_DOCS_ENABLED that is not a boolean', () => {
    expect(() => loadConfig(source({ API_DOCS_ENABLED: 'maybe' }))).toThrow(/API_DOCS_ENABLED/);
  });

  it('treats a blank value as unset, so the default applies', () => {
    const config = loadConfig(
      source({
        CACHE_TTL_SECONDS: '',
        API_DOCS_ENABLED: ' ',
        DELIVERY_BASE_URL: '',
        METRICS_TOKEN: '',
        CORS_ORIGINS: '',
      }),
    );

    expect(config.cacheTtlSeconds).toBe(300);
    expect(config.apiDocsEnabled).toBe(true);
    expect(config.deliveryBaseUrl).toBeUndefined();
    expect(config.metricsToken).toBeUndefined();
    expect(config.corsOrigins).toEqual(['http://localhost:3000']);
  });

  it('reads the body limit in bytes, 1 MiB by default', () => {
    expect(loadConfig(source()).jsonBodyLimit).toBe(1_048_576);
    expect(loadConfig(source({ JSON_BODY_LIMIT: '512kb' })).jsonBodyLimit).toBe(524_288);
    expect(loadConfig(source({ JSON_BODY_LIMIT: '2048' })).jsonBodyLimit).toBe(2_048);
  });

  it('lets JSON_BODY_LIMIT_BYTES win over JSON_BODY_LIMIT', () => {
    expect(
      loadConfig(source({ JSON_BODY_LIMIT: '2mb', JSON_BODY_LIMIT_BYTES: '4096' })).jsonBodyLimit,
    ).toBe(4_096);
  });

  it('rejects a body limit that is not a size or is out of bounds', () => {
    expect(() => loadConfig(source({ JSON_BODY_LIMIT: 'lots' }))).toThrow(/JSON_BODY_LIMIT/);
    expect(() => loadConfig(source({ JSON_BODY_LIMIT: '1tb' }))).toThrow(/JSON_BODY_LIMIT/);
    expect(() => loadConfig(source({ JSON_BODY_LIMIT: '100b' }))).toThrow(/JSON_BODY_LIMIT/);
    expect(() => loadConfig(source({ JSON_BODY_LIMIT_BYTES: '1e9' }))).toThrow(
      /JSON_BODY_LIMIT_BYTES/,
    );
  });

  it('parses sizes in the binary units of the body parser', () => {
    expect(parseByteSize('1mb')).toBe(1_048_576);
    expect(parseByteSize('1.5 KB')).toBe(1_536);
    expect(parseByteSize('10')).toBe(10);
    expect(parseByteSize('-1mb')).toBeUndefined();
  });

  it('trusts no proxy unless told to, and accepts addresses and networks', () => {
    expect(loadConfig(source()).trustedProxies).toEqual([]);
    expect(
      loadConfig(source({ TRUSTED_PROXIES: '172.16.0.0/12, 10.0.0.1,fd00::/8' })).trustedProxies,
    ).toEqual(['172.16.0.0/12', '10.0.0.1', 'fd00::/8']);
  });

  it('rejects a trusted proxy that is neither an address nor a network', () => {
    for (const value of ['*', 'nginx', '10.0.0.0/33', '10.0.0.1/8/1']) {
      expect(() => loadConfig(source({ TRUSTED_PROXIES: value }))).toThrow(/TRUSTED_PROXIES/);
    }
  });

  it('keeps SQL logging off unless LOG_SQL asks for it', () => {
    expect(loadConfig(source()).logSql).toBe(false);
    expect(loadConfig(source({ LOG_SQL: 'true' })).logSql).toBe(true);
  });
});
