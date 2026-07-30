import { cacheKey, cacheKeyPrefix } from '../../cache/keys.js';

// Module-local key builders; the shared `keys.ts` only owns namespaces that
// several modules share.
export const ANALYTICS_NAMESPACE = 'analytics';

export type ReportParameter = string | number | boolean | undefined;

/**
 * Builds a key from the normalised query parameters. Entries are sorted by name
 * and undefined values dropped, so two requests that mean the same thing map to
 * the same key regardless of how the query string was ordered.
 */
export const analyticsReportKey = (
  report: string,
  parameters: Readonly<Record<string, ReportParameter>>,
): string => {
  const encoded = Object.entries(parameters)
    .filter(
      (entry): entry is [string, Exclude<ReportParameter, undefined>] => entry[1] !== undefined,
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join('|');
  return cacheKey(ANALYTICS_NAMESPACE, report, encoded === '' ? 'all' : encoded);
};

export const analyticsPrefix = (): string => cacheKeyPrefix(ANALYTICS_NAMESPACE);
