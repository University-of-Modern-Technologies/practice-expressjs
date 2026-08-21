import { describe, expect, it, jest } from '@jest/globals';

import { createListReader } from './list-reader.js';

interface Row {
  readonly id: string;
  readonly name: string;
}

interface Dto {
  readonly id: string;
  readonly label: string;
}

const toDto = (row: Row): Dto => ({ id: row.id, label: row.name });

interface MockModel {
  readonly findMany: jest.Mock<(args: unknown) => Promise<Row[]>>;
  readonly count: jest.Mock<(args: unknown) => Promise<number>>;
}

const buildModel = (rows: Row[], total: number): MockModel => ({
  findMany: jest.fn<(args: unknown) => Promise<Row[]>>((_args) => Promise.resolve(rows)),
  count: jest.fn<(args: unknown) => Promise<number>>((_args) => Promise.resolve(total)),
});

describe('createListReader', () => {
  it('computes skip from page and pageSize', async () => {
    const model = buildModel([], 0);
    const readPage = createListReader({ model, select: { id: true }, toDto });

    await readPage({ where: {}, page: 3, pageSize: 20, orderBy: { id: 'asc' } });

    expect(model.findMany).toHaveBeenCalledWith({
      where: {},
      skip: 40,
      take: 20,
      orderBy: { id: 'asc' },
      select: { id: true },
    });
  });

  it('requests page 1 with zero skip', async () => {
    const model = buildModel([], 0);
    const readPage = createListReader({ model, select: { id: true }, toDto });

    await readPage({ where: {}, page: 1, pageSize: 10, orderBy: { id: 'asc' } });

    expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 10 }));
  });

  it('runs findMany and count against the same where clause', async () => {
    const model = buildModel([], 0);
    const readPage = createListReader({ model, select: { id: true }, toDto });
    const where = { ownerId: 'owner-1' };

    await readPage({ where, page: 1, pageSize: 10, orderBy: { id: 'asc' } });

    expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(model.count).toHaveBeenCalledWith({ where });
  });

  it('assembles the page response with mapped items and the requested paging', async () => {
    const rows: Row[] = [
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
    ];
    const model = buildModel(rows, 37);
    const readPage = createListReader({ model, select: { id: true }, toDto });

    const result = await readPage({ where: {}, page: 2, pageSize: 2, orderBy: { id: 'asc' } });

    expect(result).toEqual({
      items: [
        { id: '1', label: 'a' },
        { id: '2', label: 'b' },
      ],
      page: 2,
      pageSize: 2,
      total: 37,
    });
  });

  it('returns an empty page shape when there are no matching rows', async () => {
    const model = buildModel([], 0);
    const readPage = createListReader({ model, select: { id: true }, toDto });

    const result = await readPage({ where: {}, page: 1, pageSize: 25, orderBy: { id: 'asc' } });

    expect(result).toEqual({ items: [], page: 1, pageSize: 25, total: 0 });
  });
});
