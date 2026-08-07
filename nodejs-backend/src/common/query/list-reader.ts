/**
 * The other half of every `list()`: once the `where` clause is built, every
 * module runs the exact same skeleton to turn it into a page of results —
 * compute `skip`, run the page query and the count query together, wrap the
 * mapped rows in a page envelope. Sorting stays a call-site concern (both the
 * primary sort field and the tie-breaker differ per module), so it is passed
 * in rather than baked into the reader.
 */

export interface ListPage<TDto> {
  readonly items: readonly TDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** The subset of a Prisma model delegate a list query actually needs. */
export interface ListReaderModel<TWhere, TOrderBy, TSelect, TRecord> {
  findMany(args: {
    where: TWhere;
    skip: number;
    take: number;
    orderBy: TOrderBy;
    select: TSelect;
  }): Promise<TRecord[]>;
  count(args: { where: TWhere }): Promise<number>;
}

export interface ListReaderOptions<TWhere, TOrderBy, TSelect, TRecord, TDto> {
  readonly model: ListReaderModel<TWhere, TOrderBy, TSelect, TRecord>;
  readonly select: TSelect;
  readonly toDto: (record: TRecord) => TDto;
}

export interface ListQueryArgs<TWhere, TOrderBy> {
  readonly where: TWhere;
  readonly page: number;
  readonly pageSize: number;
  readonly orderBy: TOrderBy;
}

/**
 * Builds a reusable "run this page query" function for one Prisma model.
 * `where` and `orderBy` are supplied per call, since those are exactly what
 * differs between one module's `list()` and the next; everything else about
 * fetching a page is identical and lives here once.
 */
export const createListReader = <TWhere, TOrderBy, TSelect, TRecord, TDto>(
  options: ListReaderOptions<TWhere, TOrderBy, TSelect, TRecord, TDto>,
) => {
  const { model, select, toDto } = options;
  return async (args: ListQueryArgs<TWhere, TOrderBy>): Promise<ListPage<TDto>> => {
    const skip = (args.page - 1) * args.pageSize;
    const [items, total] = await Promise.all([
      model.findMany({
        where: args.where,
        skip,
        take: args.pageSize,
        orderBy: args.orderBy,
        select,
      }),
      model.count({ where: args.where }),
    ]);
    return { items: items.map(toDto), page: args.page, pageSize: args.pageSize, total };
  };
};
