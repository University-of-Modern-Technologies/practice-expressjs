import type { RequestHandler, Response } from 'express';

/**
 * A report is served from the cache for minutes, and nothing in the report
 * knows which writes change it: a new order moves the sales figures, a stock
 * movement moves the stock report, a reassigned deal moves the owner table.
 * Tracking that per report would be a list that goes stale the first time
 * someone adds a write without reading it. So the rule is blunt instead: any
 * successful write drops the whole namespace, and the next read builds it
 * again.
 *
 * The drop happens before the response is finished, so a client that reads
 * right after its own write never gets the figure from before it.
 */

/** Methods that may change data. Everything else is a read. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface PrefixInvalidator {
  invalidatePrefix(prefix: string): Promise<void>;
}

export interface CacheInvalidationOptions {
  readonly cache: PrefixInvalidator;
  readonly prefixes: readonly string[];
  /** Signing in writes a session, not business data. */
  readonly exemptPathPrefixes?: readonly string[];
}

export const createCacheInvalidation = ({
  cache,
  prefixes,
  exemptPathPrefixes = [],
}: CacheInvalidationOptions): RequestHandler => {
  const invalidate = async (): Promise<void> => {
    for (const prefix of prefixes) {
      await cache.invalidatePrefix(prefix);
    }
  };

  return (request, response, next) => {
    if (
      !WRITE_METHODS.has(request.method) ||
      exemptPathPrefixes.some((prefix) => request.originalUrl.startsWith(prefix))
    ) {
      next();
      return;
    }

    // Every way of answering (`json`, `send`, `end`) ends in `end`, so holding
    // it back is the one place that sees the final status before the client does.
    const end = response.end.bind(response) as (...args: unknown[]) => Response;
    response.end = ((...args: unknown[]) => {
      if (response.statusCode >= 400) return end(...args);
      // The cache service swallows its own failures, so this always resolves;
      // the `finally` keeps a response from hanging should that ever change.
      void invalidate().finally(() => end(...args));
      return response;
    }) as Response['end'];

    next();
  };
};
