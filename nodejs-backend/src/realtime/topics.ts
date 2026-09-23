/**
 * Topic vocabulary for the realtime channel.
 *
 * Topics are plain strings on the wire, but every string that reaches the
 * gateway is parsed through `parseRealtimeTopic` first, so unknown or
 * malformed names never reach the subscription registry.
 */

export const REALTIME_TOPIC_DEALS = 'deals';
export const REALTIME_TOPIC_ORDERS = 'orders';

export const realtimeCollectionTopics = [REALTIME_TOPIC_DEALS, REALTIME_TOPIC_ORDERS] as const;

export type RealtimeCollectionTopic = (typeof realtimeCollectionTopics)[number];

export const realtimeEntityTypes = [
  'deal',
  'order',
  'contact',
  'user',
  'ticket',
  'call',
  'transaction',
  'statement',
] as const;

export type RealtimeEntityType = (typeof realtimeEntityTypes)[number];

export type RealtimeEntityTopic = `entity:${RealtimeEntityType}:${string}`;

export type RealtimeTopic = RealtimeCollectionTopic | RealtimeEntityTopic;

/** Maximum accepted length of a topic string on the wire. */
export const MAX_TOPIC_LENGTH = 128;

const ENTITY_TOPIC_PREFIX = 'entity';
const ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const isCollectionTopic = (value: string): value is RealtimeCollectionTopic =>
  (realtimeCollectionTopics as readonly string[]).includes(value);

const isEntityType = (value: string): value is RealtimeEntityType =>
  (realtimeEntityTypes as readonly string[]).includes(value);

/** Builder for the `deals` collection topic. */
export const dealsTopic = (): RealtimeCollectionTopic => REALTIME_TOPIC_DEALS;

/** Builder for the `orders` collection topic. */
export const ordersTopic = (): RealtimeCollectionTopic => REALTIME_TOPIC_ORDERS;

/** Builder for a per-entity topic, e.g. `entity:deal:clx123`. */
export const entityTopic = (
  entityType: RealtimeEntityType,
  entityId: string,
): RealtimeEntityTopic => `${ENTITY_TOPIC_PREFIX}:${entityType}:${entityId}`;

/** Convenience builder for a single deal stream. */
export const dealTopic = (dealId: string): RealtimeEntityTopic => entityTopic('deal', dealId);

export const isRealtimeEntityType = (value: string): value is RealtimeEntityType =>
  (realtimeEntityTypes as readonly string[]).includes(value);

/**
 * Not every entity has a collection-wide stream: contacts and users are only
 * broadcast per entity, so subscribers cannot follow the whole table.
 */
const ENTITY_TYPE_COLLECTION_TOPICS: Readonly<
  Partial<Record<RealtimeEntityType, RealtimeCollectionTopic>>
> = {
  deal: REALTIME_TOPIC_DEALS,
  order: REALTIME_TOPIC_ORDERS,
};

export const collectionTopicForEntity = (entityType: string): RealtimeCollectionTopic | null =>
  isRealtimeEntityType(entityType) ? (ENTITY_TYPE_COLLECTION_TOPICS[entityType] ?? null) : null;

/** Convenience builder for a single order stream. */
export const orderTopic = (orderId: string): RealtimeEntityTopic => entityTopic('order', orderId);

export type ParsedRealtimeTopic =
  | { readonly kind: 'collection'; readonly topic: RealtimeCollectionTopic }
  | {
      readonly kind: 'entity';
      readonly topic: RealtimeEntityTopic;
      readonly entityType: RealtimeEntityType;
      readonly entityId: string;
    };

/**
 * Parses a wire topic string. Returns `null` for anything that is not part of
 * the published vocabulary, which the gateway turns into an error frame.
 */
export const parseRealtimeTopic = (value: string): ParsedRealtimeTopic | null => {
  if (value.length === 0 || value.length > MAX_TOPIC_LENGTH) return null;

  if (isCollectionTopic(value)) {
    return { kind: 'collection', topic: value };
  }

  const segments = value.split(':');
  if (segments.length !== 3) return null;

  const [prefix, entityType, entityId] = segments;
  if (prefix !== ENTITY_TOPIC_PREFIX) return null;
  if (entityType === undefined || !isEntityType(entityType)) return null;
  if (entityId === undefined || !ENTITY_ID_PATTERN.test(entityId)) return null;

  return {
    kind: 'entity',
    topic: entityTopic(entityType, entityId),
    entityType,
    entityId,
  };
};

/** Type guard for topic strings received from clients. */
export const isRealtimeTopic = (value: string): value is RealtimeTopic =>
  parseRealtimeTopic(value) !== null;

export interface TopicPermissionRequirement {
  readonly resource: string;
  readonly action: string;
}

const ENTITY_TYPE_RESOURCES: Readonly<Record<RealtimeEntityType, string>> = {
  deal: 'deals',
  order: 'orders',
  contact: 'contacts',
  user: 'users',
  ticket: 'helpdesk',
  call: 'calls',
  transaction: 'finance',
  statement: 'finance',
};

/**
 * Maps a topic onto the permission a subscriber needs. The gateway never uses
 * this itself — it is exported so the composition root can implement
 * `canSubscribe` on top of the RBAC service without duplicating the mapping.
 */
export const topicPermissionRequirement = (topic: string): TopicPermissionRequirement | null => {
  const parsed = parseRealtimeTopic(topic);
  if (!parsed) return null;

  const resource =
    parsed.kind === 'collection' ? parsed.topic : ENTITY_TYPE_RESOURCES[parsed.entityType];

  return { resource, action: 'read' };
};
