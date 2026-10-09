const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

/**
 * Renders the document the way it is committed: keys sorted at every level and
 * a trailing newline, so two runs over the same code produce the same bytes and
 * a diff shows only what the code changed. Array order is kept, since in a
 * description it carries meaning (parameters, enum values, required fields).
 */
export const serializeOpenApiDocument = (document: object): string =>
  `${JSON.stringify(sortKeys(document), null, 2)}\n`;
