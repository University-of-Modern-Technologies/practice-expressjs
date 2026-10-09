export interface LoadEnvOptions {
  /** Target of the load; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Folder holding the backend `.env`; the shared one is read from its parent. */
  readonly backendRoot?: string;
}

/** Storage URLs built from their parts; `undefined` when a required part is missing. */
export interface StorageUrls {
  readonly DATABASE_URL: string | undefined;
  readonly REDIS_URL: string | undefined;
  readonly MONGODB_URL: string | undefined;
}

export declare const assembleStorageUrls: (env: NodeJS.ProcessEnv) => StorageUrls;

export declare const loadEnv: (options?: LoadEnvOptions) => NodeJS.ProcessEnv;
