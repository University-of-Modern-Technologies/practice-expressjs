import { isIP } from 'node:net';

import { z } from 'zod';

import { loadEnv } from './load-env.cjs';

// Runs on import, before anything reads `process.env`: Prisma takes
// `DATABASE_URL` straight from it, and the storage URLs are assembled here.
loadEnv();

const DEFAULT_PORT = 8000;

// The same bounds the sibling backend puts on its body limit.
const MIN_BODY_LIMIT_BYTES = 1_024;
const MAX_BODY_LIMIT_BYTES = 67_108_864;
const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;

const BYTE_UNITS = { b: 1, kb: 1_024, mb: 1_024 ** 2, gb: 1_024 ** 3 } as const;

/**
 * A size such as `1mb`, `512kb` or `1048576` in bytes, in the binary units the
 * body parser itself uses; anything else is `undefined`.
 */
export const parseByteSize = (value: string): number | undefined => {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(value.trim());
  if (!match) return undefined;
  const unit = (match[2]?.toLowerCase() ?? 'b') as keyof typeof BYTE_UNITS;
  return Math.floor(Number(match[1]) * BYTE_UNITS[unit]);
};

const bodyLimitSchema = z.coerce.number().int().min(MIN_BODY_LIMIT_BYTES).max(MAX_BODY_LIMIT_BYTES);

/** An address or a CIDR network, IPv4 or IPv6. */
const isAddressOrNetwork = (entry: string): boolean => {
  const [address = '', bits, ...rest] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (bits === undefined) return true;
  return /^\d+$/.test(bits) && Number(bits) <= (version === 4 ? 32 : 128);
};

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * A blank value means "not set", so the default applies: `KEY=` in a `.env`
 * file behaves like a commented-out line, exactly as in the sibling backend.
 */
const withoutBlankValues = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  // `PORT` wins; without it the shared `API_PORT` is used.
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  API_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  // `JSON_BODY_LIMIT_BYTES` wins; `JSON_BODY_LIMIT` is the same size with a unit.
  JSON_BODY_LIMIT: z
    .string()
    .transform((value, context): number => {
      const bytes = parseByteSize(value);
      if (bytes === undefined || bytes < MIN_BODY_LIMIT_BYTES || bytes > MAX_BODY_LIMIT_BYTES) {
        context.addIssue({
          code: 'custom',
          message: `JSON_BODY_LIMIT must be a size such as 1mb or 512kb, from ${String(MIN_BODY_LIMIT_BYTES)} to ${String(MAX_BODY_LIMIT_BYTES)} bytes`,
        });
        return z.NEVER;
      }
      return bytes;
    })
    .optional(),
  JSON_BODY_LIMIT_BYTES: bodyLimitSchema.optional(),
  // Addresses or CIDR networks of the reverse proxies in front of the API. Only
  // a request that arrives from one of them has its X-Forwarded-For believed.
  TRUSTED_PROXIES: z
    .string()
    .refine((value) => splitList(value).every(isAddressOrNetwork), {
      message: 'TRUSTED_PROXIES must be a comma-separated list of addresses or CIDR networks',
    })
    .optional(),
  // Logs every SQL statement together with its parameters; never in production.
  LOG_SQL: z.stringbool().default(false),
  DATABASE_URL: z.url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  REDIS_URL: z.url(),
  REDIS_KEY_PREFIX: z.string().min(1).default('crm:'),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(300),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(100_000).default(300),
  AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(10_000).default(10),
  MONGODB_URL: z.url(),
  EVENT_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(90),
  WS_PATH: z
    .string()
    .min(1)
    .regex(/^\//, 'WS_PATH must start with a slash')
    .default('/api/v1/realtime'),
  // Absent means on everywhere except production, where the API is not advertised.
  API_DOCS_ENABLED: z.stringbool().optional(),
  // Absent means the scrape endpoint is not exposed at all.
  METRICS_TOKEN: z.string().min(16).optional(),
  SHUTDOWN_GRACE_PERIOD_MS: z.coerce.number().int().min(0).max(300_000).default(10_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(300_000).default(15_000),
  SHUTDOWN_DRAIN_DELAY_MS: z.coerce.number().int().min(0).max(300_000).default(0),

  // Delivery integration. Every default keeps the module on the in-repo stub
  // transport, so a fresh checkout answers the integration endpoints without a
  // carrier account; only a base URL switches it to a real provider.
  DELIVERY_BASE_URL: z.url().optional(),
  DELIVERY_API_KEY: z.string().min(1).optional(),
  DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(5_000),
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  DELIVERY_BASE_BACKOFF_MS: z.coerce.number().int().min(0).max(60_000).default(100),
  DELIVERY_MAX_BACKOFF_MS: z.coerce.number().int().min(0).max(60_000).default(1_000),
  DELIVERY_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  DELIVERY_COOLDOWN_MS: z.coerce.number().int().min(0).max(600_000).default(30_000),
  DELIVERY_QUOTE_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(60),

  // Assistant. Absent endpoint means the offline mock provider, which is the
  // deterministic default the tests and a fresh checkout rely on.
  AI_ENDPOINT_URL: z.url().optional(),
  AI_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().min(1).optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(2),
  AI_MAX_TOKENS: z.coerce.number().int().min(1).max(100_000).default(400),
  AI_MAX_INPUT_CHARS: z.coerce.number().int().min(100).max(1_000_000).default(4_000),
  AI_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(300),

  // Telephony. Absent base URL means the built-in offline stub, so a fresh
  // checkout imports a journal without a carrier account.
  CALL_PROVIDER_BASE_URL: z.url().optional(),
  CALL_PROVIDER_API_KEY: z.string().min(1).optional(),
  CALL_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(5_000),
  CALL_PROVIDER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  CALL_PROVIDER_BACKOFF_MS: z.coerce.number().int().min(0).max(60_000).default(200),
  CALL_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),

  // Absent means each dependency picks its own stand-in exactly as it always
  // has (a mock AI provider, a stub delivery transport, a real cache backed by
  // Redis). `offline` forces every stand-in at once, ignoring the settings
  // above; `live` is the same as leaving it unset.
  INFRA_PROFILE: z.enum(['offline', 'live']).optional(),
});

export type AppConfig = Readonly<{
  appEnv: z.infer<typeof envSchema>['APP_ENV'];
  host: string;
  port: number;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  corsOrigins: readonly string[];
  /** The largest request body accepted, in bytes. */
  jsonBodyLimit: number;
  /** Proxies whose X-Forwarded-For is believed; empty means none is. */
  trustedProxies: readonly string[];
  logSql: boolean;
  databaseUrl: string;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  redisUrl: string;
  redisKeyPrefix: string;
  cacheTtlSeconds: number;
  rateLimitWindowSeconds: number;
  rateLimitMaxRequests: number;
  authRateLimitMaxRequests: number;
  mongodbUrl: string;
  eventLogRetentionDays: number;
  wsPath: string;
  /** Serves `/api/docs` and `/api/openapi.json`. */
  apiDocsEnabled: boolean;
  metricsToken?: string | undefined;
  shutdownGracePeriodMs: number;
  shutdownTimeoutMs: number;
  shutdownDrainDelayMs: number;
  deliveryBaseUrl?: string | undefined;
  deliveryApiKey?: string | undefined;
  deliveryTimeoutMs: number;
  deliveryMaxAttempts: number;
  deliveryBaseBackoffMs: number;
  deliveryMaxBackoffMs: number;
  deliveryFailureThreshold: number;
  deliveryCooldownMs: number;
  deliveryQuoteCacheTtlSeconds: number;
  aiEndpointUrl?: string | undefined;
  aiApiKey?: string | undefined;
  aiModel?: string | undefined;
  aiTimeoutMs: number;
  aiMaxAttempts: number;
  aiMaxTokens: number;
  aiMaxInputChars: number;
  aiCacheTtlSeconds: number;
  callProviderBaseUrl?: string | undefined;
  callProviderApiKey?: string | undefined;
  callProviderTimeoutMs: number;
  callProviderMaxAttempts: number;
  callProviderBackoffMs: number;
  callSyncBatchSize: number;
  infraProfile?: z.infer<typeof envSchema>['INFRA_PROFILE'];
}>;

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(withoutBlankValues(source));

  if (!parsed.success) {
    const details = z.prettifyError(parsed.error);
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return {
    appEnv: parsed.data.APP_ENV,
    host: parsed.data.HOST,
    port: parsed.data.PORT ?? parsed.data.API_PORT ?? DEFAULT_PORT,
    logLevel: parsed.data.LOG_LEVEL,
    corsOrigins: splitList(parsed.data.CORS_ORIGINS),
    jsonBodyLimit:
      parsed.data.JSON_BODY_LIMIT_BYTES ?? parsed.data.JSON_BODY_LIMIT ?? DEFAULT_BODY_LIMIT_BYTES,
    trustedProxies: splitList(parsed.data.TRUSTED_PROXIES ?? ''),
    logSql: parsed.data.LOG_SQL,
    databaseUrl: parsed.data.DATABASE_URL,
    jwtAccessSecret: parsed.data.JWT_ACCESS_SECRET,
    jwtRefreshSecret: parsed.data.JWT_REFRESH_SECRET,
    redisUrl: parsed.data.REDIS_URL,
    redisKeyPrefix: parsed.data.REDIS_KEY_PREFIX,
    cacheTtlSeconds: parsed.data.CACHE_TTL_SECONDS,
    rateLimitWindowSeconds: parsed.data.RATE_LIMIT_WINDOW_SECONDS,
    rateLimitMaxRequests: parsed.data.RATE_LIMIT_MAX_REQUESTS,
    authRateLimitMaxRequests: parsed.data.AUTH_RATE_LIMIT_MAX_REQUESTS,
    mongodbUrl: parsed.data.MONGODB_URL,
    eventLogRetentionDays: parsed.data.EVENT_LOG_RETENTION_DAYS,
    wsPath: parsed.data.WS_PATH,
    apiDocsEnabled: parsed.data.API_DOCS_ENABLED ?? parsed.data.APP_ENV !== 'production',
    metricsToken: parsed.data.METRICS_TOKEN,
    shutdownGracePeriodMs: parsed.data.SHUTDOWN_GRACE_PERIOD_MS,
    shutdownTimeoutMs: parsed.data.SHUTDOWN_TIMEOUT_MS,
    shutdownDrainDelayMs: parsed.data.SHUTDOWN_DRAIN_DELAY_MS,
    deliveryBaseUrl: parsed.data.DELIVERY_BASE_URL,
    deliveryApiKey: parsed.data.DELIVERY_API_KEY,
    deliveryTimeoutMs: parsed.data.DELIVERY_TIMEOUT_MS,
    deliveryMaxAttempts: parsed.data.DELIVERY_MAX_ATTEMPTS,
    deliveryBaseBackoffMs: parsed.data.DELIVERY_BASE_BACKOFF_MS,
    deliveryMaxBackoffMs: parsed.data.DELIVERY_MAX_BACKOFF_MS,
    deliveryFailureThreshold: parsed.data.DELIVERY_FAILURE_THRESHOLD,
    deliveryCooldownMs: parsed.data.DELIVERY_COOLDOWN_MS,
    deliveryQuoteCacheTtlSeconds: parsed.data.DELIVERY_QUOTE_CACHE_TTL_SECONDS,
    aiEndpointUrl: parsed.data.AI_ENDPOINT_URL,
    aiApiKey: parsed.data.AI_API_KEY,
    aiModel: parsed.data.AI_MODEL,
    aiTimeoutMs: parsed.data.AI_TIMEOUT_MS,
    aiMaxAttempts: parsed.data.AI_MAX_ATTEMPTS,
    aiMaxTokens: parsed.data.AI_MAX_TOKENS,
    aiMaxInputChars: parsed.data.AI_MAX_INPUT_CHARS,
    aiCacheTtlSeconds: parsed.data.AI_CACHE_TTL_SECONDS,
    callProviderBaseUrl: parsed.data.CALL_PROVIDER_BASE_URL,
    callProviderApiKey: parsed.data.CALL_PROVIDER_API_KEY,
    callProviderTimeoutMs: parsed.data.CALL_PROVIDER_TIMEOUT_MS,
    callProviderMaxAttempts: parsed.data.CALL_PROVIDER_MAX_ATTEMPTS,
    callProviderBackoffMs: parsed.data.CALL_PROVIDER_BACKOFF_MS,
    callSyncBatchSize: parsed.data.CALL_SYNC_BATCH_SIZE,
    infraProfile: parsed.data.INFRA_PROFILE,
  };
};
