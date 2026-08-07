import { describe, expect, it, jest } from '@jest/globals';

import { createRealtimeSubscriber } from './composition-root.js';
import type { DomainEventNotification } from './common/types/index.js';
import type { RealtimeGateway } from './realtime/index.js';

/**
 * Only `publish` is exercised here; the rest of the gateway plays no part in
 * the fan-out and a partial fake keeps the cases about the one behaviour they
 * are asserting.
 */
const gatewayWith = (publish: RealtimeGateway['publish']): RealtimeGateway =>
  ({ publish }) as unknown as RealtimeGateway;

const change: DomainEventNotification = {
  eventType: 'order.status_transitioned',
  entityType: 'order',
  entityId: 'ord-1',
};

describe('realtime subscriber', () => {
  it('puts a change on both the collection stream and the record stream', () => {
    const publish = jest.fn<RealtimeGateway['publish']>();

    createRealtimeSubscriber(gatewayWith(publish)).notify(change);

    expect(publish.mock.calls.map(([topic]) => topic)).toEqual(['orders', 'entity:order:ord-1']);
  });

  // A client watching one order must not go silent because the collection
  // stream is the one that broke.
  it('still reaches the record stream when the collection stream throws', () => {
    const publish = jest.fn<RealtimeGateway['publish']>((topic) => {
      if (topic === 'orders') throw new Error('collection stream is down');
    });

    expect(() => createRealtimeSubscriber(gatewayWith(publish)).notify(change)).toThrow(
      'collection stream is down',
    );
    expect(publish.mock.calls.map(([topic]) => topic)).toEqual(['orders', 'entity:order:ord-1']);
  });

  it('still reaches the collection stream when the record stream throws', () => {
    const publish = jest.fn<RealtimeGateway['publish']>((topic) => {
      if (topic === 'entity:order:ord-1') throw new Error('record stream is down');
    });

    expect(() => createRealtimeSubscriber(gatewayWith(publish)).notify(change)).toThrow(
      'record stream is down',
    );
    expect(publish.mock.calls).toHaveLength(2);
  });

  // The failure is rethrown rather than swallowed so the fan-out can log it;
  // the first one is what gets reported when both streams are down.
  it('reports the first failure when every stream is down', () => {
    const publish = jest.fn<RealtimeGateway['publish']>((topic) => {
      throw new Error(`${topic} is down`);
    });

    expect(() => createRealtimeSubscriber(gatewayWith(publish)).notify(change)).toThrow(
      'orders is down',
    );
  });

  it('says nothing about an entity that has no realtime stream', () => {
    const publish = jest.fn<RealtimeGateway['publish']>();

    createRealtimeSubscriber(gatewayWith(publish)).notify({
      ...change,
      entityType: 'audit_log',
    });

    expect(publish).not.toHaveBeenCalled();
  });
});
