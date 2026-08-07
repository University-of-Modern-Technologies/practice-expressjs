import 'dotenv/config';

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:3100'),
  JSON_BODY_LIMIT: z.string().min(1).default('1mb'),
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

  // Absent means each dependency picks its own stand-in exactly as it always
  // has (a mock AI provider, a stub delivery transport, a real cache backed by
  // Redis). `offline` forces every stand-in at once, ignoring the settings
  // above; `live` is the same as leaving it unset.
  INFRA_PROFILE: z.enum(['offline', 'live']).optional(),
});

export type AppConfig = Readonly<{
  nodeEnv: z.infer<typeof envSchema>['NODE_ENV'];
  host: string;
  port: number;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  corsOrigins: readonly string[];
  jsonBodyLimit: string;
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
  infraProfile?: z.infer<typeof envSchema>['INFRA_PROFILE'];
}>;

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = z.prettifyError(parsed.error);
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    corsOrigins: parsed.data.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    jsonBodyLimit: parsed.data.JSON_BODY_LIMIT,
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
    infraProfile: parsed.data.INFRA_PROFILE,
  };
};
