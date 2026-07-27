import { describe, expect, it, jest } from '@jest/globals';

import {
  createDomainEventSubject,
  type DomainEventNotification,
  type DomainEventSubscriber,
} from './domain-event-publisher.js';

const EVENT: DomainEventNotification = {
  eventType: 'deal.created',
  entityType: 'deal',
  entityId: 'd-1',
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('createDomainEventSubject', () => {
  it('notifies every registered subscriber', async () => {
    const seen: string[] = [];
    const first: DomainEventSubscriber = {
      name: 'first',
      notify: () => {
        seen.push('first');
      },
    };
    const second: DomainEventSubscriber = {
      name: 'second',
      notify: () => {
        seen.push('second');
      },
    };

    const subject = createDomainEventSubject();
    subject.subscribe(first);
    subject.subscribe(second);

    subject.publish(EVENT);
    await flush();

    expect(seen).toEqual(['first', 'second']);
  });

  it('does not let a subscriber that throws synchronously stop the rest', async () => {
    const seen: string[] = [];
    const broken: DomainEventSubscriber = {
      name: 'broken',
      notify: () => {
        throw new Error('boom');
      },
    };
    const healthy: DomainEventSubscriber = {
      name: 'healthy',
      notify: () => {
        seen.push('healthy');
      },
    };

    const subject = createDomainEventSubject();
    subject.subscribe(broken);
    subject.subscribe(healthy);

    expect(() => {
      subject.publish(EVENT);
    }).not.toThrow();
    await flush();

    expect(seen).toEqual(['healthy']);
  });

  it('does not let a subscriber whose promise rejects stop the rest', async () => {
    const seen: string[] = [];
    const broken: DomainEventSubscriber = {
      name: 'broken',
      notify: (): Promise<void> => Promise.reject(new Error('boom')),
    };
    const healthy: DomainEventSubscriber = {
      name: 'healthy',
      notify: () => {
        seen.push('healthy');
      },
    };

    const subject = createDomainEventSubject();
    subject.subscribe(broken);
    subject.subscribe(healthy);

    subject.publish(EVENT);
    await flush();

    expect(seen).toEqual(['healthy']);
  });

  it('reports subscriber failures through the diagnostics hook without throwing', async () => {
    const onSubscriberError = jest.fn();
    const broken: DomainEventSubscriber = {
      name: 'broken',
      notify: () => {
        throw new Error('boom');
      },
    };

    const subject = createDomainEventSubject({ onSubscriberError });
    subject.subscribe(broken);

    subject.publish(EVENT);
    await flush();

    expect(onSubscriberError).toHaveBeenCalledTimes(1);
    expect(onSubscriberError).toHaveBeenCalledWith(broken, expect.any(Error));
  });

  it('stops notifying a subscriber once it has unsubscribed', async () => {
    const seen: string[] = [];
    const subscriber: DomainEventSubscriber = {
      name: 'sub',
      notify: () => {
        seen.push('notified');
      },
    };

    const subject = createDomainEventSubject();
    const unsubscribe = subject.subscribe(subscriber);

    subject.publish(EVENT);
    await flush();
    unsubscribe();
    subject.publish(EVENT);
    await flush();

    expect(seen).toEqual(['notified']);
  });
});
