/** What an integration run puts over the loaded environment. */
export interface IntegrationTestEnv {
  readonly APP_ENV: 'test';
  readonly DATABASE_URL: string;
  readonly REDIS_URL: string;
  readonly MONGODB_URL: string;
  readonly REDIS_KEY_PREFIX: string;
  readonly SEED_USER_PASSWORD: string;
  readonly JWT_ACCESS_SECRET: string;
  readonly JWT_REFRESH_SECRET: string;
  readonly LOG_LEVEL: 'silent';
}

export declare const integrationTestEnv: (env: NodeJS.ProcessEnv) => IntegrationTestEnv;

export declare const storageAddress: (url: string) => string;

export declare const databaseName: (url: string) => string;

export declare const maintenanceDatabaseUrl: (databaseUrl: string) => string;
