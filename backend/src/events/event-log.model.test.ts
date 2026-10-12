import { describe, expect, it } from '@jest/globals';
import pino from 'pino';

import {
  ACTOR_HISTORY_INDEX,
  ENTITY_HISTORY_INDEX,
  EVENT_TYPE_INDEX,
  type EventLogIndexCollection,
  type IndexKeys,
  RETENTION_INDEX,
  SECONDS_PER_DAY,
  ensureEventLogIndexes,
} from './event-log.model.js';

const logger = pino({ level: 'silent' });

interface StoredIndex {
  name: string;
  key: Record<string, unknown>;
  expireAfterSeconds?: number;
}

const sameKeys = (left: Record<string, unknown>, right: IndexKeys): boolean =>
  JSON.stringify(Object.entries(left)) === JSON.stringify(Object.entries(right));

/** Answers the way the server does: one name per definition, one name per key. */
class FakeIndexCollection implements EventLogIndexCollection {
  stored: StoredIndex[] = [{ name: '_id_', key: { _id: 1 } }];
  readonly dropped: string[] = [];

  async createIndex(
    keys: IndexKeys,
    options: { name: string; expireAfterSeconds?: number },
  ): Promise<string> {
    await Promise.resolve();
    const byName = this.stored.find((index) => index.name === options.name);
    if (byName) {
      const identical =
        sameKeys(byName.key, keys) && byName.expireAfterSeconds === options.expireAfterSeconds;
      if (identical) return options.name;
      throw Object.assign(new Error('Index exists with different options'), {
        code: sameKeys(byName.key, keys) ? 85 : 86,
      });
    }
    if (this.stored.some((index) => sameKeys(index.key, keys))) {
      throw Object.assign(new Error('Index already exists with a different name'), { code: 85 });
    }
    this.stored.push({ ...options, key: { ...keys } });
    return options.name;
  }

  async indexes(): Promise<readonly StoredIndex[]> {
    await Promise.resolve();
    return this.stored;
  }

  async dropIndex(name: string): Promise<void> {
    await Promise.resolve();
    this.stored = this.stored.filter((index) => index.name !== name);
    this.dropped.push(name);
  }

  byName(name: string): StoredIndex | undefined {
    return this.stored.find((index) => index.name === name);
  }
}

describe('event log indexes', () => {
  it('creates the history, search and retention indexes under the shared names', async () => {
    const collection = new FakeIndexCollection();

    await ensureEventLogIndexes(collection, 90, logger);

    expect(collection.byName(EVENT_TYPE_INDEX)?.key).toEqual({ eventType: 1 });
    expect(collection.byName(ENTITY_HISTORY_INDEX)?.key).toEqual({
      entityType: 1,
      entityId: 1,
      occurredAt: -1,
    });
    expect(collection.byName(ACTOR_HISTORY_INDEX)?.key).toEqual({ actorId: 1, occurredAt: -1 });
    expect(collection.byName(RETENTION_INDEX)).toMatchObject({
      key: { occurredAt: 1 },
      expireAfterSeconds: 90 * SECONDS_PER_DAY,
    });
    // The sibling backend's names, so an index listing reads the same in both.
    expect([EVENT_TYPE_INDEX, ENTITY_HISTORY_INDEX, ACTOR_HISTORY_INDEX, RETENTION_INDEX]).toEqual([
      'event_type_idx',
      'entity_history_idx',
      'actor_history_idx',
      'occurred_at_ttl_idx',
    ]);
  });

  it('is idempotent', async () => {
    const collection = new FakeIndexCollection();

    await ensureEventLogIndexes(collection, 90, logger);
    await ensureEventLogIndexes(collection, 90, logger);

    expect(collection.dropped).toEqual([]);
    expect(collection.stored).toHaveLength(5);
  });

  it('applies a changed retention window instead of keeping the old one', async () => {
    const collection = new FakeIndexCollection();
    await ensureEventLogIndexes(collection, 90, logger);

    await ensureEventLogIndexes(collection, 30, logger);

    expect(collection.dropped).toEqual([RETENTION_INDEX]);
    expect(collection.byName(RETENTION_INDEX)?.expireAfterSeconds).toBe(30 * SECONDS_PER_DAY);
  });

  it('replaces the unnamed indexes the schema used to create, then creates the rest', async () => {
    const collection = new FakeIndexCollection();
    // What `autoIndex` left behind in a development database.
    collection.stored.push(
      { name: 'eventType_1', key: { eventType: 1 } },
      { name: 'occurredAt_1', key: { occurredAt: 1 }, expireAfterSeconds: 90 * SECONDS_PER_DAY },
    );

    await ensureEventLogIndexes(collection, 90, logger);

    expect(collection.dropped).toEqual(['eventType_1', 'occurredAt_1']);
    expect(collection.stored.map((index) => index.name).sort()).toEqual(
      ['_id_', ACTOR_HISTORY_INDEX, ENTITY_HISTORY_INDEX, EVENT_TYPE_INDEX, RETENTION_INDEX].sort(),
    );
  });
});
