import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnv } from './load-env.cjs';

const SHARED_ENV = [
  'APP_ENV=development',
  'API_PORT=8000',
  'POSTGRES_PORT=15432',
  'REDIS_PORT=16379',
  'MONGO_PORT=27018',
  'POSTGRES_DB=practice_crm',
  'POSTGRES_USER=practice_crm',
  'POSTGRES_PASSWORD=practice-local-password',
  'MONGO_DB=practice_events',
  'MONGO_USER=practice_crm',
  'MONGO_PASSWORD=practice-local-password',
].join('\n');

let repositoryRoot: string;
let backendRoot: string;

/** Writes the shared `.env` and, when given, the backend's own. */
const writeEnvFiles = (shared: string | null, backend: string | null = null): void => {
  if (shared !== null) writeFileSync(join(repositoryRoot, '.env'), shared);
  if (backend !== null) writeFileSync(join(backendRoot, '.env'), backend);
};

const load = (given: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  loadEnv({ env: { ...given }, backendRoot });

beforeEach(() => {
  repositoryRoot = mkdtempSync(join(tmpdir(), 'load-env-'));
  backendRoot = join(repositoryRoot, 'backend');
  mkdirSync(backendRoot);
});

afterEach(() => {
  rmSync(repositoryRoot, { recursive: true, force: true });
});

describe('loadEnv', () => {
  it('assembles every storage URL from the parts in the shared .env', () => {
    writeEnvFiles(SHARED_ENV);

    const env = load();

    expect(env.DATABASE_URL).toBe(
      'postgresql://practice_crm:practice-local-password@127.0.0.1:15432/practice_crm?schema=public',
    );
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:16379');
    expect(env.MONGODB_URL).toBe(
      'mongodb://practice_crm:practice-local-password@127.0.0.1:27018/practice_events?authSource=admin',
    );
  });

  it('keeps an explicitly given URL over the assembled one', () => {
    writeEnvFiles(SHARED_ENV);

    const env = load({
      DATABASE_URL: 'postgresql://ci:secret@db.internal:5432/crm_ci?schema=public',
      REDIS_URL: 'redis://cache.internal:6379',
      MONGODB_URL: 'mongodb://events.internal:27017/events_ci',
    });

    expect(env.DATABASE_URL).toBe('postgresql://ci:secret@db.internal:5432/crm_ci?schema=public');
    expect(env.REDIS_URL).toBe('redis://cache.internal:6379');
    expect(env.MONGODB_URL).toBe('mongodb://events.internal:27017/events_ci');
  });

  it('keeps a URL written in the backend .env over the assembled one', () => {
    writeEnvFiles(SHARED_ENV, 'DATABASE_URL=postgresql://own:own@127.0.0.1:5432/own?schema=public');

    expect(load().DATABASE_URL).toBe('postgresql://own:own@127.0.0.1:5432/own?schema=public');
  });

  it('lets the process environment win over the backend .env, and that over the shared one', () => {
    writeEnvFiles('LOG_LEVEL=warn\nWS_PATH=/shared\nREDIS_PORT=1', 'LOG_LEVEL=debug\nREDIS_PORT=2');

    const env = load({ REDIS_PORT: '3' });

    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.WS_PATH).toBe('/shared');
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:3');
  });

  it('uses the given storage hosts, which is how the containers reach each other', () => {
    writeEnvFiles(SHARED_ENV);

    const env = load({
      POSTGRES_HOST: 'postgres',
      POSTGRES_PORT: '5432',
      REDIS_HOST: 'redis',
      REDIS_PORT: '6379',
      MONGO_HOST: 'mongo',
      MONGO_PORT: '27017',
    });

    expect(env.DATABASE_URL).toBe(
      'postgresql://practice_crm:practice-local-password@postgres:5432/practice_crm?schema=public',
    );
    expect(env.REDIS_URL).toBe('redis://redis:6379');
    expect(env.MONGODB_URL).toBe(
      'mongodb://practice_crm:practice-local-password@mongo:27017/practice_events?authSource=admin',
    );
  });

  it('falls back to the default loopback ports', () => {
    const env = load({
      POSTGRES_DB: 'crm',
      POSTGRES_USER: 'crm',
      POSTGRES_PASSWORD: 'crm',
      MONGO_DB: 'events',
    });

    expect(env.DATABASE_URL).toBe('postgresql://crm:crm@127.0.0.1:5432/crm?schema=public');
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:6379');
    expect(env.MONGODB_URL).toBe('mongodb://127.0.0.1:27017/events');
  });

  it('encodes credentials that would otherwise break the URL', () => {
    const env = load({
      POSTGRES_DB: 'crm',
      POSTGRES_USER: 'app@crm',
      POSTGRES_PASSWORD: 'p@ss:w/rd#1',
      MONGO_DB: 'events',
      MONGO_USER: 'app',
      MONGO_PASSWORD: 'p@ss:w/rd#1',
    });

    expect(env.DATABASE_URL).toBe(
      'postgresql://app%40crm:p%40ss%3Aw%2Frd%231@127.0.0.1:5432/crm?schema=public',
    );
    expect(env.MONGODB_URL).toBe(
      'mongodb://app:p%40ss%3Aw%2Frd%231@127.0.0.1:27017/events?authSource=admin',
    );
  });

  it('leaves a URL unset when a part it needs is missing, so validation can name it', () => {
    const env = load({
      DATABASE_URL: ' ',
      POSTGRES_DB: 'crm',
      POSTGRES_USER: 'crm',
      MONGO_USER: 'events',
    });

    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('MONGODB_URL');
  });

  it('works without either .env file', () => {
    const env = load();

    expect(env.APP_ENV).toBe('development');
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:6379');
  });

  it('copies APP_ENV into NODE_ENV', () => {
    writeEnvFiles('APP_ENV=production');

    const env = load();

    expect(env.APP_ENV).toBe('production');
    expect(env.NODE_ENV).toBe('production');
  });

  it('prefers APP_ENV over NODE_ENV within the same layer', () => {
    expect(load({ APP_ENV: 'production', NODE_ENV: 'development' }).NODE_ENV).toBe('production');

    writeEnvFiles('NODE_ENV=development\nAPP_ENV=test');
    expect(load().APP_ENV).toBe('test');
  });

  it('lets an environment the process was started with outrank the files', () => {
    writeEnvFiles(SHARED_ENV);

    expect(load({ NODE_ENV: 'test' }).APP_ENV).toBe('test');
    expect(load({ APP_ENV: 'production' }).APP_ENV).toBe('production');
  });

  it('accepts the legacy NODE_ENV when APP_ENV is given nowhere', () => {
    writeEnvFiles('NODE_ENV=production');

    expect(load().APP_ENV).toBe('production');
  });

  it('gives the same result when called again', () => {
    writeEnvFiles(SHARED_ENV);
    const env = load({ NODE_ENV: 'test' });
    const first = { ...env };

    loadEnv({ env, backendRoot });

    expect(env).toEqual(first);
  });
});
