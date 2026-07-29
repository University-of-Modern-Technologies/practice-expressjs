/**
 * Outbound notification of a committed domain change.
 *
 * Publishing happens *after* the database transaction commits and is
 * deliberately synchronous and fire-and-forget: the event stream and the
 * realtime channel are secondary consumers, so neither may delay nor roll back
 * the business operation that produced them.
 */
export interface DomainEventNotification {
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorId?: string | null;
  readonly requestId?: string | null;
  readonly payload?: unknown;
}

export interface DomainEventPublisher {
  publish(event: DomainEventNotification): void;
}

/** Default for callers that are constructed without the infrastructure. */
export const noopDomainEventPublisher: DomainEventPublisher = {
  publish(): void {
    // Intentionally empty: unit tests and offline tooling need no fan-out.
  },
};

/**
 * A secondary consumer registered against a {@link DomainEventSubject}.
 *
 * `notify` may be async; the subject awaits it but never lets a rejection
 * escape, so one subscriber's failure can never stop the others from being
 * notified.
 */
export interface DomainEventSubscriber {
  /** Identifies the subscriber in diagnostics. */
  readonly name: string;
  notify(event: DomainEventNotification): void | Promise<void>;
}

/**
 * A publisher that consumers can register against instead of being wired in
 * by hand, so adding a subscriber never requires touching the fan-out body.
 */
export interface DomainEventSubject extends DomainEventPublisher {
  /** Registers a subscriber and returns the matching unsubscribe. */
  subscribe(subscriber: DomainEventSubscriber): () => void;
}

/**
 * Builds a subject that fans a published event out to every subscriber
 * currently registered.
 *
 * Subscribers are notified in registration order, and each is isolated by
 * its own try/catch so a failing subscriber can never prevent the rest from
 * being notified. `publish` itself never throws and never awaits delivery:
 * it is fire-and-forget by contract, matching {@link DomainEventPublisher}.
 */
export const createDomainEventSubject = (options?: {
  onSubscriberError?: (subscriber: DomainEventSubscriber, error: unknown) => void;
}): DomainEventSubject => {
  const subscribers = new Set<DomainEventSubscriber>();

  const notifyOne = (subscriber: DomainEventSubscriber, event: DomainEventNotification): void => {
    try {
      void Promise.resolve(subscriber.notify(event)).catch((error: unknown) => {
        options?.onSubscriberError?.(subscriber, error);
      });
    } catch (error) {
      options?.onSubscriberError?.(subscriber, error);
    }
  };

  return {
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    publish(event) {
      for (const subscriber of subscribers) {
        notifyOne(subscriber, event);
      }
    },
  };
};
