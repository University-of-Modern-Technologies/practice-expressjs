/**
 * Loads the demonstration data set.
 *
 * This is deliberately *not* the canonical seed. The canonical set is small,
 * hand-written and load-bearing: the contract scenarios log in as its users and
 * read its rows, so growing it would break them wholesale. This script adds a
 * second, much larger set on top, in its own identifier range, and the two never
 * meet.
 *
 * Nothing here invents data. Every row comes from the committed fixture under
 * `prisma/demo-data`, which the sibling backend reads as well — one fixture, two
 * databases, identical rows.
 *
 * Run with `npm run db:seed:demo`. The canonical seed has to have run first:
 * roles are looked up by name rather than created here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();

const DATA_DIRECTORY = join(__dirname, 'demo-data');

/** Postgres binds one parameter per element of an `IN` list. */
const DELETE_CHUNK = 2000;

interface FixtureUser {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface FixtureContact {
  id: string;
  ownerId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface FixtureDeal {
  id: string;
  ownerId: string;
  contactId: string | null;
  title: string;
  stage: string;
  amount: string;
  currency: string;
  probability: number;
  version: number;
  expectedCloseDate: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface FixtureProduct {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  unitPrice: string;
  currency: string;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface FixtureWarehouse {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface FixtureStockLevel {
  id: string;
  warehouseId: string;
  productId: string;
  quantityOnHand: number;
  quantityReserved: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface FixtureStockMovement {
  id: string;
  warehouseId: string;
  productId: string;
  type: string;
  quantity: number;
  referenceType: string | null;
  referenceId: string | null;
  actorId: string | null;
  note: string | null;
  createdAt: string;
}

interface FixtureOrder {
  id: string;
  orderNumber: string;
  ownerId: string;
  contactId: string | null;
  dealId: string | null;
  status: string;
  currency: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  notes: string | null;
  version: number;
  placedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface FixtureOrderItem {
  id: string;
  orderId: string;
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  createdAt: string;
  updatedAt: string;
}

interface FixtureAuditLog {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changes: Prisma.InputJsonValue | null;
  metadata: Prisma.InputJsonValue | null;
  ipAddress: string | null;
  createdAt: string;
}

function read<T>(file: string): T[] {
  const text = readFileSync(join(DATA_DIRECTORY, file), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** A date, or null — the fixture writes ISO strings and nulls, nothing else. */
const at = (value: string | null): Date | null => (value === null ? null : new Date(value));

function getSeedPassword(): string {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The demonstration seed is local-only and cannot run in production.');
  }

  const password = process.env.SEED_USER_PASSWORD;
  if (!password || password.length < 12 || password === 'change-me') {
    throw new Error('SEED_USER_PASSWORD must contain at least 12 non-placeholder characters.');
  }

  return password;
}

/**
 * Removes exactly the rows a previous run of this script wrote, named one by
 * one from the fixture, and nothing else.
 *
 * An earlier version deleted by identifier range instead, which reads as the
 * tidier idea and is wrong: rows the canonical seed leaves to the database to
 * identify — stock levels, and every audit entry the running application
 * writes — get a random UUID, and one in sixteen of those lands inside the
 * demonstration range. Measured, not theorised: a second run of the range
 * version destroyed a canonical stock level.
 *
 * A row the application created against a demonstration record will block the
 * delete through a foreign key. That is the intended outcome: refusing to
 * reload is better than quietly removing somebody's work.
 */
async function clearPreviousRun(ids: Record<string, string[]>): Promise<void> {
  const remove = async (
    name: string,
    deleteMany: (values: string[]) => Promise<unknown>,
  ): Promise<void> => {
    const values = ids[name] ?? [];
    for (let start = 0; start < values.length; start += DELETE_CHUNK) {
      await deleteMany(values.slice(start, start + DELETE_CHUNK));
    }
  };

  await remove('auditLogs', (values) => prisma.auditLog.deleteMany({ where: { id: { in: values } } }));
  await remove('stockMovements', (values) =>
    prisma.stockMovement.deleteMany({ where: { id: { in: values } } }),
  );
  await remove('stockLevels', (values) =>
    prisma.stockLevel.deleteMany({ where: { id: { in: values } } }),
  );
  await remove('orderItems', (values) =>
    prisma.orderItem.deleteMany({ where: { id: { in: values } } }),
  );
  await remove('orders', (values) => prisma.order.deleteMany({ where: { id: { in: values } } }));
  await remove('warehouses', (values) =>
    prisma.warehouse.deleteMany({ where: { id: { in: values } } }),
  );
  await remove('products', (values) => prisma.product.deleteMany({ where: { id: { in: values } } }));
  await remove('deals', (values) => prisma.deal.deleteMany({ where: { id: { in: values } } }));
  await remove('contacts', (values) => prisma.contact.deleteMany({ where: { id: { in: values } } }));
  await remove('users', (values) =>
    prisma.userRole.deleteMany({ where: { userId: { in: values } } }),
  );
  await remove('users', (values) => prisma.user.deleteMany({ where: { id: { in: values } } }));
}

async function main(): Promise<void> {
  const passwordHash = await hash(getSeedPassword(), 12);

  const users = read<FixtureUser>('users.ndjson');
  const contacts = read<FixtureContact>('contacts.ndjson');
  const deals = read<FixtureDeal>('deals.ndjson');
  const products = read<FixtureProduct>('products.ndjson');
  const warehouses = read<FixtureWarehouse>('warehouses.ndjson');
  const orders = read<FixtureOrder>('orders.ndjson');
  const orderItems = read<FixtureOrderItem>('order-items.ndjson');
  const stockLevels = read<FixtureStockLevel>('stock-levels.ndjson');
  const stockMovements = read<FixtureStockMovement>('stock-movements.ndjson');
  const auditLogs = read<FixtureAuditLog>('audit-logs.ndjson');

  const roles = await prisma.role.findMany({ select: { id: true, name: true } });
  const roleByName = new Map(roles.map((role) => [role.name, role.id]));
  for (const user of users) {
    if (!roleByName.has(user.role)) {
      throw new Error(
        `Role "${user.role}" is missing. Run the canonical seed (npm run db:seed) first.`,
      );
    }
  }

  await clearPreviousRun({
    users: users.map((row) => row.id),
    contacts: contacts.map((row) => row.id),
    deals: deals.map((row) => row.id),
    products: products.map((row) => row.id),
    warehouses: warehouses.map((row) => row.id),
    orders: orders.map((row) => row.id),
    orderItems: orderItems.map((row) => row.id),
    stockLevels: stockLevels.map((row) => row.id),
    stockMovements: stockMovements.map((row) => row.id),
    auditLogs: auditLogs.map((row) => row.id),
  });

  await prisma.user.createMany({
    data: users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      passwordHash,
      isActive: user.isActive,
      createdAt: new Date(user.createdAt),
      updatedAt: new Date(user.updatedAt),
    })),
  });

  await prisma.userRole.createMany({
    data: users.map((user) => ({
      userId: user.id,
      // Checked above, so the assertion cannot fire at runtime.
      roleId: roleByName.get(user.role) as string,
    })),
  });

  await prisma.contact.createMany({
    data: contacts.map((contact) => ({
      id: contact.id,
      ownerId: contact.ownerId,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      company: contact.company,
      notes: contact.notes,
      createdAt: new Date(contact.createdAt),
      updatedAt: new Date(contact.updatedAt),
      deletedAt: at(contact.deletedAt),
    })),
  });

  await prisma.deal.createMany({
    data: deals.map((deal) => ({
      id: deal.id,
      ownerId: deal.ownerId,
      contactId: deal.contactId,
      title: deal.title,
      stage: deal.stage as Prisma.DealCreateManyInput['stage'],
      amount: deal.amount,
      currency: deal.currency,
      probability: deal.probability,
      version: deal.version,
      expectedCloseDate: at(deal.expectedCloseDate),
      closedAt: at(deal.closedAt),
      createdAt: new Date(deal.createdAt),
      updatedAt: new Date(deal.updatedAt),
      deletedAt: at(deal.deletedAt),
    })),
  });

  await prisma.product.createMany({
    data: products.map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
      description: product.description,
      category: product.category,
      unitPrice: product.unitPrice,
      currency: product.currency,
      isActive: product.isActive,
      version: product.version,
      createdAt: new Date(product.createdAt),
      updatedAt: new Date(product.updatedAt),
      deletedAt: at(product.deletedAt),
    })),
  });

  await prisma.warehouse.createMany({
    data: warehouses.map((warehouse) => ({
      id: warehouse.id,
      code: warehouse.code,
      name: warehouse.name,
      isActive: warehouse.isActive,
      createdAt: new Date(warehouse.createdAt),
      updatedAt: new Date(warehouse.updatedAt),
    })),
  });

  await prisma.order.createMany({
    data: orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      ownerId: order.ownerId,
      contactId: order.contactId,
      dealId: order.dealId,
      status: order.status as Prisma.OrderCreateManyInput['status'],
      currency: order.currency,
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      taxTotal: order.taxTotal,
      total: order.total,
      notes: order.notes,
      version: order.version,
      placedAt: at(order.placedAt),
      createdAt: new Date(order.createdAt),
      updatedAt: new Date(order.updatedAt),
      deletedAt: at(order.deletedAt),
    })),
  });

  await prisma.orderItem.createMany({
    data: orderItems.map((item) => ({
      id: item.id,
      orderId: item.orderId,
      productId: item.productId,
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    })),
  });

  await prisma.stockLevel.createMany({
    data: stockLevels.map((level) => ({
      id: level.id,
      warehouseId: level.warehouseId,
      productId: level.productId,
      quantityOnHand: level.quantityOnHand,
      quantityReserved: level.quantityReserved,
      version: level.version,
      createdAt: new Date(level.createdAt),
      updatedAt: new Date(level.updatedAt),
    })),
  });

  await prisma.stockMovement.createMany({
    data: stockMovements.map((movement) => ({
      id: movement.id,
      warehouseId: movement.warehouseId,
      productId: movement.productId,
      type: movement.type as Prisma.StockMovementCreateManyInput['type'],
      quantity: movement.quantity,
      referenceType: movement.referenceType,
      referenceId: movement.referenceId,
      actorId: movement.actorId,
      note: movement.note,
      createdAt: new Date(movement.createdAt),
    })),
  });

  await prisma.auditLog.createMany({
    data: auditLogs.map((entry) => ({
      id: entry.id,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      changes: entry.changes ?? Prisma.DbNull,
      metadata: entry.metadata ?? Prisma.DbNull,
      ipAddress: entry.ipAddress,
      createdAt: new Date(entry.createdAt),
    })),
  });

  console.log(
    [
      'Demonstration data loaded:',
      `  users            ${users.length}`,
      `  contacts         ${contacts.length}`,
      `  deals            ${deals.length}`,
      `  products         ${products.length}`,
      `  warehouses       ${warehouses.length}`,
      `  orders           ${orders.length}`,
      `  order items      ${orderItems.length}`,
      `  stock levels     ${stockLevels.length}`,
      `  stock movements  ${stockMovements.length}`,
      `  audit entries    ${auditLogs.length}`,
    ].join('\n'),
  );
}

main()
  .catch((error: unknown) => {
    console.error('Demonstration seed failed.', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
