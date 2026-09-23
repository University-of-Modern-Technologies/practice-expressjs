import type { Router } from 'express';
import type { Logger } from 'pino';

import { createApp, type MountedRouter, type ReadinessCheck } from './app/index.js';
import { createDatabaseReadinessCheck } from './app/health/index.js';
import { createRedisClient, disconnectRedis, type CacheService } from './cache/index.js';
import { createRateLimiter, createAuthRateLimiter } from './common/middleware/rate-limit.js';
import {
  createMetricsRegistry,
  registerProcessMetrics,
  type MetricsRegistry,
} from './common/observability/index.js';
import {
  createDomainEventSubject,
  type DomainEventNotification,
  type DomainEventPublisher,
  type DomainEventSubscriber,
} from './common/types/index.js';
import { createLogger, type AppConfig } from './config/index.js';
import { disconnectPrisma, prisma } from './db/prisma.js';
import {
  connectEventStore,
  createEventStoreReadinessCheck,
  createEventStoreService,
  disconnectEventStore,
  type EventStoreService,
} from './events/index.js';
import { createInfraStack } from './infra-profile/index.js';
import {
  createAiController,
  createAiRouter,
  createAiService,
  type AiProvider,
} from './modules/ai/index.js';
import {
  createAnalyticsController,
  createAnalyticsRouter,
  createAnalyticsService,
} from './modules/analytics/index.js';
import {
  createAuditController,
  createAuditRouter,
  createAuditService,
} from './modules/audit/index.js';
import {
  createAuthController,
  createAuthenticate,
  createAuthRouter,
  createAuthService,
  REFRESH_COOKIE_NAME,
  type AuthConfig,
} from './modules/auth/index.js';
import {
  createCallProvider,
  createCallsController,
  createCallsRouter,
  createCallsService,
} from './modules/calls/index.js';
import {
  createContactsController,
  createContactsRouter,
  createContactsService,
} from './modules/contacts/index.js';
import {
  createDealsController,
  createDealsRouter,
  createDealsService,
} from './modules/deals/index.js';
import {
  createFinanceController,
  createFinanceRouter,
  createFinanceService,
  createStubBankProvider,
} from './modules/finance/index.js';
import {
  createHelpdeskController,
  createHelpdeskRouter,
  createHelpdeskService,
} from './modules/helpdesk/index.js';
import {
  createIntegrationsController,
  createIntegrationsRouter,
  createIntegrationsService,
  type DeliveryClient,
} from './modules/integrations/index.js';
import {
  createOrdersController,
  createOrdersRouter,
  createOrdersService,
} from './modules/orders/index.js';
import {
  createProductsController,
  createProductsRouter,
  createProductsService,
} from './modules/products/index.js';
import { createRbacController, createRbacRouter, createRbacService } from './modules/rbac/index.js';
import {
  createSettingsController,
  createSettingsRouter,
  createSettingsService,
} from './modules/settings/index.js';
import {
  createUsersController,
  createUsersRouter,
  createUsersService,
} from './modules/users/index.js';
import {
  createStockOperationsInTransaction,
  createWarehouseController,
  createWarehouseRouter,
  createWarehouseService,
} from './modules/warehouse/index.js';
import {
  collectionTopicForEntity,
  createRealtimeGateway,
  entityTopic,
  isRealtimeEntityType,
  topicPermissionRequirement,
  type RealtimeGateway,
} from './realtime/index.js';

export interface ModuleFactoryResult {
  readonly path: string;
  readonly router: Router;
  readonly readinessChecks?: readonly ReadinessCheck[];
}

export interface CompositionRoot {
  readonly app: ReturnType<typeof createApp>;
  readonly logger: Logger;
  readonly realtime: RealtimeGateway;
  readonly events: EventStoreService;
  /** Connects the dependencies that are established outside the request path. */
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Appends a committed change to the durable event log. */
export const createEventLogSubscriber = (events: EventStoreService): DomainEventSubscriber => ({
  name: 'event-log',
  notify(event) {
    return events.append({
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      actorId: event.actorId ?? null,
      requestId: event.requestId ?? null,
      payload: event.payload ?? null,
    });
  },
});

/** The streams one committed change belongs on: the collection, and the record. */
const realtimeTopicsFor = (event: DomainEventNotification): readonly string[] => {
  const topics: string[] = [];
  const collection = collectionTopicForEntity(event.entityType);
  if (collection) topics.push(collection);
  if (isRealtimeEntityType(event.entityType)) {
    topics.push(entityTopic(event.entityType, event.entityId));
  }
  return topics;
};

/** Forwards a committed change to connected realtime clients. */
export const createRealtimeSubscriber = (realtime: RealtimeGateway): DomainEventSubscriber => ({
  name: 'realtime',
  notify(event) {
    // Every topic is attempted, even after one of them fails: a client watching
    // a single record must still hear the change when it was the collection
    // stream that broke, and the other way round. The first failure is kept and
    // rethrown once the rest have been delivered, so the fan-out still reports
    // it instead of losing it to a swallowed catch.
    let failure: unknown;
    let failed = false;
    for (const topic of realtimeTopicsFor(event)) {
      try {
        realtime.publish(topic, event);
      } catch (error) {
        if (!failed) {
          failure = error;
          failed = true;
        }
      }
    }
    if (failed) throw failure;
  },
});

/**
 * Builds the fan-out subject and registers the two secondary consumers. Both
 * are best-effort by contract, so failures are contained per-subscriber and
 * never surface to the caller that produced the change; a third consumer can
 * be added here with another `subscribe` call, without touching either
 * subscriber's own logic.
 */
const createDomainEventPublisher = (
  events: EventStoreService,
  realtime: RealtimeGateway,
  logger: Logger,
): DomainEventPublisher => {
  const subject = createDomainEventSubject({
    onSubscriberError: (subscriber, error) => {
      logger.error({ err: error, subscriber: subscriber.name }, 'Domain event subscriber failed');
    },
  });

  subject.subscribe(createEventLogSubscriber(events));
  subject.subscribe(createRealtimeSubscriber(realtime));

  return subject;
};

const createAuthConfig = (config: AppConfig): AuthConfig => ({
  accessTokenSecret: config.jwtAccessSecret,
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
  refreshCookieName: REFRESH_COOKIE_NAME,
  refreshCookiePath: '/api/v1/auth',
  secureCookies: config.nodeEnv === 'production',
});

interface ModuleDependencies {
  readonly config: AppConfig;
  readonly cache: CacheService;
  readonly logger: Logger;
  /** Built once by the infra profile; modules consume it, they do not choose it. */
  readonly aiProvider: AiProvider;
  readonly deliveryClient: DeliveryClient;
}

interface ModuleGraph {
  readonly modules: readonly ModuleFactoryResult[];
  readonly realtime: RealtimeGateway;
  readonly events: EventStoreService;
}

const createModules = ({
  config,
  cache,
  logger,
  aiProvider,
  deliveryClient,
}: ModuleDependencies): ModuleGraph => {
  const authConfig = createAuthConfig(config);
  const auditService = createAuditService(prisma);
  const eventStore = createEventStoreService(logger, config);
  const rbacService = createRbacService(prisma, cache, config.cacheTtlSeconds);
  const authService = createAuthService(prisma, authConfig);
  const authenticate = createAuthenticate(authService);

  // The gateway never imports RBAC; authorisation is injected so that the
  // realtime channel enforces exactly the same permissions as the HTTP API.
  const realtime = createRealtimeGateway({
    config,
    logger,
    verifyAccessToken: (token) => authService.authenticate(token),
    async canSubscribe(auth, topic) {
      const requirement = topicPermissionRequirement(topic);
      if (!requirement) return false;

      const scope = await rbacService.getPermissionScope(
        auth.userId,
        requirement.resource,
        requirement.action,
      );

      return scope !== null;
    },
  });

  const authController = createAuthController(authService, authConfig);
  const usersController = createUsersController(createUsersService(prisma, rbacService));
  const rbacController = createRbacController(rbacService);
  const contactsController = createContactsController(
    createContactsService(prisma, auditService),
    rbacService,
  );
  const publisher = createDomainEventPublisher(eventStore, realtime, logger);
  const dealsController = createDealsController(
    createDealsService(prisma, auditService, publisher),
    rbacService,
  );
  const callsController = createCallsController(
    createCallsService(
      prisma,
      auditService,
      createCallProvider({
        config: {
          baseUrl: config.callProviderBaseUrl,
          apiKey: config.callProviderApiKey,
          timeoutMs: config.callProviderTimeoutMs,
          maxAttempts: config.callProviderMaxAttempts,
          backoffMs: config.callProviderBackoffMs,
        },
        logger,
      }),
      publisher,
      { syncBatchSize: config.callSyncBatchSize },
    ),
    rbacService,
  );
  const financeController = createFinanceController(
    createFinanceService(prisma, auditService, createStubBankProvider(), publisher),
    rbacService,
  );
  const helpdeskController = createHelpdeskController(
    createHelpdeskService(prisma, auditService, publisher),
    rbacService,
  );
  const auditController = createAuditController(auditService, rbacService);
  const productsController = createProductsController(
    createProductsService(prisma, auditService, publisher),
    rbacService,
  );
  const settingsService = createSettingsService(
    prisma,
    auditService,
    cache,
    config.cacheTtlSeconds,
  );
  const ordersController = createOrdersController(
    createOrdersService(prisma, auditService, publisher, {
      operations: createStockOperationsInTransaction(auditService, publisher),
      // Which warehouse serves an order is a deployment choice, so it is read
      // from settings rather than hard-coded. The lookup runs on the order's own
      // transaction so it observes the same snapshot as the stock writes. An
      // inactive warehouse is returned deliberately: the stock guard then
      // reports WAREHOUSE_INACTIVE, which is more precise than a generic
      // "not configured".
      resolveWarehouseId: async (transaction) => {
        const code = await settingsService.get('warehouse.defaultCode');
        const warehouse = await transaction.warehouse.findUnique({
          where: { code },
          select: { id: true },
        });

        return warehouse?.id ?? null;
      },
    }),
    rbacService,
  );
  const warehouseController = createWarehouseController(
    createWarehouseService(prisma, auditService, publisher),
    rbacService,
  );
  const settingsController = createSettingsController(settingsService);
  const analyticsController = createAnalyticsController(
    createAnalyticsService(prisma, cache, config.cacheTtlSeconds),
  );
  // Both adapters come from the infra profile: which one runs against a
  // stand-in and which against a real endpoint was already decided together,
  // once, rather than each looking at its own setting here.
  const integrationsController = createIntegrationsController(
    createIntegrationsService(deliveryClient, { cache }),
    rbacService,
  );
  const aiController = createAiController(createAiService(aiProvider, { cache }), rbacService);

  return {
    realtime,
    events: eventStore,
    modules: [
      { path: '/api/v1/auth', router: createAuthRouter(authController, authenticate) },
      {
        path: '/api/v1/users',
        router: createUsersRouter(usersController, authenticate, rbacService),
      },
      {
        path: '/api/v1/rbac',
        router: createRbacRouter(rbacController, authenticate, rbacService),
      },
      { path: '/api/v1/contacts', router: createContactsRouter(contactsController, authenticate) },
      { path: '/api/v1/deals', router: createDealsRouter(dealsController, authenticate) },
      { path: '/api/v1/audit', router: createAuditRouter(auditController, authenticate) },
      { path: '/api/v1/helpdesk', router: createHelpdeskRouter(helpdeskController, authenticate) },
      { path: '/api/v1/calls', router: createCallsRouter(callsController, authenticate) },
      { path: '/api/v1/finance', router: createFinanceRouter(financeController, authenticate) },
      { path: '/api/v1/products', router: createProductsRouter(productsController, authenticate) },
      { path: '/api/v1/orders', router: createOrdersRouter(ordersController, authenticate) },
      {
        path: '/api/v1/warehouse',
        router: createWarehouseRouter(warehouseController, authenticate),
      },
      {
        path: '/api/v1/settings',
        router: createSettingsRouter(settingsController, authenticate, rbacService),
      },
      {
        path: '/api/v1/analytics',
        router: createAnalyticsRouter(analyticsController, authenticate, rbacService),
      },
      {
        path: '/api/v1/integrations',
        router: createIntegrationsRouter(integrationsController, authenticate),
      },
      { path: '/api/v1/ai', router: createAiRouter(aiController, authenticate) },
    ],
  };
};

export const createCompositionRoot = (config: AppConfig): CompositionRoot => {
  const logger = createLogger(config);
  const redis = createRedisClient(config, logger);
  const { cache, aiProvider, deliveryClient } = createInfraStack({ config, redis, logger });
  const metrics: MetricsRegistry = createMetricsRegistry();
  registerProcessMetrics(metrics);

  const { modules, realtime, events } = createModules({
    config,
    cache,
    logger,
    aiProvider,
    deliveryClient,
  });
  const routers: MountedRouter[] = modules.map(({ path, router }) => ({ path, router }));
  const readinessChecks: readonly ReadinessCheck[] = [
    createDatabaseReadinessCheck(prisma),
    {
      // A cache outage degrades latency but not correctness, so it must never
      // take the instance out of the load balancer pool.
      name: 'cache',
      critical: false,
      async check() {
        await redis.ping();
      },
    },
    createEventStoreReadinessCheck(),
    ...modules.flatMap((module) => module.readinessChecks ?? []),
  ];

  // The limiter loads its Lua script into Redis as soon as it is built, so it is
  // left out of test runs entirely rather than reaching for infrastructure that
  // unit tests deliberately do not provide.
  const throttling =
    config.nodeEnv === 'test'
      ? {}
      : {
          rateLimiter: createRateLimiter(redis, config, logger),
          authRateLimiter: createAuthRateLimiter(redis, config, logger),
        };

  const app = createApp({
    config,
    logger,
    routers,
    readinessChecks,
    metrics,
    ...throttling,
  });

  return {
    app,
    logger,
    realtime,
    events,
    async start() {
      await connectEventStore(config, logger);
    },
    async close() {
      await realtime.close();
      await disconnectEventStore();
      await disconnectRedis(redis);
      await disconnectPrisma();
      logger.flush();
    },
  };
};
