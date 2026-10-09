export interface LoadEnvOptions {
  /** Target of the load; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Folder holding the backend `.env`; the shared one is read from its parent. */
  readonly backendRoot?: string;
}

export declare const loadEnv: (options?: LoadEnvOptions) => NodeJS.ProcessEnv;
