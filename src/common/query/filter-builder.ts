/**
 * Every `list()` in this codebase assembles a Prisma `where` clause the same
 * way: add a condition only when the caller actually supplied a value, skip it
 * otherwise. Spelled out inline that rule turns into a spread-ternary per
 * field and grows unreadable fast (a filter with a handful of ranges runs to
 * dozens of lines). This builder factors the rule out so call sites read as a
 * list of "what this endpoint can be filtered by" instead of "how to skip an
 * absent value".
 */

/** A value the caller left unset. `0` and `false` are real values, not this. */
type Unset = undefined | null | '';

const isUnset = (value: unknown): value is Unset =>
  value === undefined || value === null || value === '';

/** One field to search, with per-field control over case sensitivity. */
export type SearchField = string | { readonly field: string; readonly insensitive: boolean };

const searchClause = (
  value: string,
  field: SearchField,
): Record<string, { contains: string; mode?: 'insensitive' }> => {
  const { field: name, insensitive } =
    typeof field === 'string' ? { field, insensitive: true } : field;
  return { [name]: insensitive ? { contains: value, mode: 'insensitive' } : { contains: value } };
};

/**
 * Builds a Prisma `WhereInput` incrementally. Every method is a no-op for an
 * unset value, so a call site can chain every possible filter unconditionally
 * and let the builder decide which ones actually end up in the query.
 */
export class WhereFilterBuilder<TWhere extends Record<string, unknown>> {
  private readonly clauses: Record<string, unknown>;

  constructor(base: Partial<TWhere> = {}) {
    this.clauses = { ...base };
  }

  /** Exact match. Skipped when `value` is unset; `0` and `false` are kept. */
  equals(field: string, value: unknown): this {
    if (!isUnset(value)) this.clauses[field] = value;
    return this;
  }

  /**
   * `gte`/`lte` bounds on one field. Either bound may be omitted; the field is
   * left out of the clause entirely when both are unset. `transform` converts
   * a raw bound (e.g. an ISO date string) into what Prisma expects.
   */
  range<TBound>(
    field: string,
    min: TBound | Unset,
    max: TBound | Unset,
    transform?: (value: TBound) => unknown,
  ): this {
    const gte = isUnset(min) ? undefined : transform ? transform(min) : min;
    const lte = isUnset(max) ? undefined : transform ? transform(max) : max;
    if (gte !== undefined || lte !== undefined) {
      this.clauses[field] = {
        ...(gte !== undefined ? { gte } : {}),
        ...(lte !== undefined ? { lte } : {}),
      };
    }
    return this;
  }

  /**
   * `OR`-across-fields substring search. A no-op when `value` is unset, which
   * also means an unset search never overwrites an `OR` set some other way.
   */
  search(value: string | undefined, fields: readonly SearchField[]): this {
    if (isUnset(value)) return this;
    this.clauses.OR = fields.map((field) => searchClause(value, field));
    return this;
  }

  /** Escape hatch for a condition that isn't equality, a range, or a search. */
  extend(extra: Record<string, unknown>): this {
    Object.assign(this.clauses, extra);
    return this;
  }

  build(): TWhere {
    return this.clauses as TWhere;
  }
}

/** Starts a filter builder, optionally seeded with fields that are always present (e.g. `deletedAt: null`). */
export const filter = <TWhere extends Record<string, unknown>>(
  base: Partial<TWhere> = {},
): WhereFilterBuilder<TWhere> => new WhereFilterBuilder<TWhere>(base);
