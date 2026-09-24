import { DealStage, OrderStatus, PermissionScope, PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();

const ids = {
  users: {
    admin: '10000000-0000-4000-8000-000000000001',
    manager: '10000000-0000-4000-8000-000000000002',
    viewer: '10000000-0000-4000-8000-000000000003',
  },
  contacts: {
    northwind: '20000000-0000-4000-8000-000000000001',
    bluePeak: '20000000-0000-4000-8000-000000000002',
    cedarLabs: '20000000-0000-4000-8000-000000000003',
  },
  deals: {
    onboarding: '30000000-0000-4000-8000-000000000001',
    renewal: '30000000-0000-4000-8000-000000000002',
    pilot: '30000000-0000-4000-8000-000000000003',
  },
  products: {
    licence: '40000000-0000-4000-8000-000000000001',
    workshop: '40000000-0000-4000-8000-000000000002',
    support: '40000000-0000-4000-8000-000000000003',
    // Neither of these carries a real business meaning — they exist so a
    // change that reads "may this product be archived" has one case that
    // says yes without any preparation and one closed-order-only case to
    // read, instead of forcing every test to build that state itself.
    unblocked: '40000000-0000-4000-8000-000000000004',
    closedOrderOnly: '40000000-0000-4000-8000-000000000005',
  },
  warehouses: {
    central: '50000000-0000-4000-8000-000000000001',
    regional: '50000000-0000-4000-8000-000000000002',
  },
  orders: {
    confirmed: '60000000-0000-4000-8000-000000000001',
    draft: '60000000-0000-4000-8000-000000000002',
    fulfilled: '60000000-0000-4000-8000-000000000003',
  },
  orderItems: {
    confirmedLicence: '70000000-0000-4000-8000-000000000001',
    confirmedSupport: '70000000-0000-4000-8000-000000000002',
    draftWorkshop: '70000000-0000-4000-8000-000000000003',
    fulfilledClosedOrderOnly: '70000000-0000-4000-8000-000000000004',
  },
} as const;

const permissionDefinitions = [
  ['users:read', 'View users'],
  ['users:create', 'Create users'],
  ['users:update', 'Update users'],
  ['users:disable', 'Disable users'],
  ['contacts:read', 'View contacts'],
  ['contacts:write', 'Create and update contacts'],
  ['contacts:delete', 'Soft-delete contacts'],
  ['deals:read', 'View deals'],
  ['deals:write', 'Create and update deals'],
  ['deals:delete', 'Soft-delete deals'],
  ['audit:read', 'View audit history'],
  ['products:read', 'View the product catalogue'],
  ['products:write', 'Create and update products'],
  ['products:delete', 'Soft-delete products'],
  ['orders:read', 'View orders'],
  ['orders:write', 'Create and update orders'],
  ['orders:delete', 'Soft-delete orders'],
  ['warehouse:read', 'View stock levels and movements'],
  ['warehouse:write', 'Receive, issue and adjust stock'],
  ['settings:read', 'View organization settings'],
  ['settings:write', 'Change organization settings'],
  ['analytics:read', 'View reports and aggregations'],
  ['integrations:read', 'View integration status'],
  ['integrations:write', 'Trigger integration operations'],
  ['ai:use', 'Use the AI assistance features'],
] as const;

const roleDefinitions = [
  ['admin', 'Full application administration'],
  ['manager', 'CRM team management'],
  ['viewer', 'Read-only access to owned CRM records'],
] as const;

async function hashPassword(password: string): Promise<string> {
  return hash(password, 12);
}

function getSeedPassword(): string {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The training seed is local-only and cannot run in production.');
  }

  const password = process.env.SEED_USER_PASSWORD;
  if (!password || password.length < 12 || password === 'change-me') {
    throw new Error('SEED_USER_PASSWORD must contain at least 12 non-placeholder characters.');
  }

  return password;
}

async function main(): Promise<void> {
  const passwordHash = await hashPassword(getSeedPassword());

  await prisma.$transaction(async (tx) => {
    const roles = new Map<string, string>();
    for (const [name, description] of roleDefinitions) {
      const role = await tx.role.upsert({
        where: { name },
        update: { description },
        create: { name, description },
      });
      roles.set(name, role.id);
    }

    const permissions = new Map<string, string>();
    for (const [key, description] of permissionDefinitions) {
      const permission = await tx.permission.upsert({
        where: { key },
        update: { description },
        create: { key, description },
      });
      permissions.set(key, permission.id);
    }

    const users = [
      {
        id: ids.users.admin,
        email: 'admin@crm-training.example',
        name: 'Avery Admin',
        role: 'admin',
      },
      {
        id: ids.users.manager,
        email: 'manager@crm-training.example',
        name: 'Morgan Manager',
        role: 'manager',
      },
      {
        id: ids.users.viewer,
        email: 'viewer@crm-training.example',
        name: 'Taylor Viewer',
        role: 'viewer',
      },
    ] as const;

    for (const user of users) {
      await tx.user.upsert({
        where: { id: user.id },
        update: {
          email: user.email,
          name: user.name,
          passwordHash,
          isActive: true,
        },
        create: {
          id: user.id,
          email: user.email,
          name: user.name,
          passwordHash,
        },
      });

      await tx.userRole.upsert({
        where: {
          userId_roleId: {
            userId: user.id,
            roleId: roles.get(user.role)!,
          },
        },
        update: {},
        create: {
          userId: user.id,
          roleId: roles.get(user.role)!,
        },
      });
    }

    const grants: Record<
      (typeof roleDefinitions)[number][0],
      ReadonlyArray<readonly [string, PermissionScope]>
    > = {
      admin: permissionDefinitions.map(([key]) => [key, PermissionScope.ALL]),
      manager: [
        ['users:read', PermissionScope.ALL],
        ['contacts:read', PermissionScope.ALL],
        ['contacts:write', PermissionScope.ALL],
        ['contacts:delete', PermissionScope.ALL],
        ['deals:read', PermissionScope.ALL],
        ['deals:write', PermissionScope.ALL],
        ['deals:delete', PermissionScope.ALL],
        ['audit:read', PermissionScope.ALL],
        ['products:read', PermissionScope.ALL],
        ['products:write', PermissionScope.ALL],
        ['orders:read', PermissionScope.ALL],
        ['orders:write', PermissionScope.ALL],
        ['orders:delete', PermissionScope.ALL],
        ['warehouse:read', PermissionScope.ALL],
        ['warehouse:write', PermissionScope.ALL],
        ['settings:read', PermissionScope.ALL],
        ['analytics:read', PermissionScope.ALL],
        ['integrations:read', PermissionScope.ALL],
        ['ai:use', PermissionScope.ALL],
      ],
      viewer: [
        ['contacts:read', PermissionScope.OWN],
        ['deals:read', PermissionScope.OWN],
        ['products:read', PermissionScope.ALL],
        ['orders:read', PermissionScope.OWN],
        ['warehouse:read', PermissionScope.ALL],
      ],
    };

    for (const [roleName, roleGrants] of Object.entries(grants)) {
      for (const [permissionKey, scope] of roleGrants) {
        await tx.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: roles.get(roleName)!,
              permissionId: permissions.get(permissionKey)!,
            },
          },
          update: { scope },
          create: {
            roleId: roles.get(roleName)!,
            permissionId: permissions.get(permissionKey)!,
            scope,
          },
        });
      }
    }

    const contacts = [
      {
        id: ids.contacts.northwind,
        ownerId: ids.users.manager,
        firstName: 'Alex',
        lastName: 'North',
        email: 'alex.north@example.test',
        phone: '+1-555-0101',
        company: 'Northwind Workshop',
        notes: 'Synthetic training contact.',
      },
      {
        id: ids.contacts.bluePeak,
        ownerId: ids.users.manager,
        firstName: 'Jordan',
        lastName: 'Blue',
        email: 'jordan.blue@example.test',
        phone: '+1-555-0102',
        company: 'Blue Peak Studio',
        notes: 'Synthetic training contact.',
      },
      {
        id: ids.contacts.cedarLabs,
        ownerId: ids.users.viewer,
        firstName: 'Casey',
        lastName: 'Cedar',
        email: 'casey.cedar@example.test',
        phone: '+1-555-0103',
        company: 'Cedar Labs',
        notes: 'Synthetic training contact owned by the viewer.',
      },
    ] as const;

    for (const contact of contacts) {
      await tx.contact.upsert({
        where: { id: contact.id },
        update: { ...contact, deletedAt: null },
        create: contact,
      });
    }

    const deals = [
      {
        id: ids.deals.onboarding,
        ownerId: ids.users.manager,
        contactId: ids.contacts.northwind,
        title: 'Team onboarding package',
        stage: DealStage.QUALIFIED,
        amount: '4800.00',
        currency: 'USD',
        probability: 25,
        version: 1,
      },
      {
        id: ids.deals.renewal,
        ownerId: ids.users.manager,
        contactId: ids.contacts.bluePeak,
        title: 'Annual service renewal',
        stage: DealStage.PROPOSAL,
        amount: '12500.00',
        currency: 'USD',
        probability: 75,
        version: 1,
      },
      {
        id: ids.deals.pilot,
        ownerId: ids.users.viewer,
        contactId: ids.contacts.cedarLabs,
        title: 'Training workspace pilot',
        stage: DealStage.LEAD,
        amount: '2400.00',
        currency: 'USD',
        probability: 10,
        version: 1,
      },
    ] as const;

    for (const deal of deals) {
      await tx.deal.upsert({
        where: { id: deal.id },
        update: { ...deal, deletedAt: null },
        create: deal,
      });
    }

    const products = [
      {
        id: ids.products.licence,
        sku: 'LIC-TEAM-01',
        name: 'Team licence, annual',
        description: 'Annual licence for a single team workspace.',
        category: 'Licences',
        unitPrice: '1200.00',
        currency: 'USD',
      },
      {
        id: ids.products.workshop,
        sku: 'SRV-WS-02',
        name: 'Onboarding workshop',
        description: 'Two-day onboarding workshop for a new team.',
        category: 'Services',
        unitPrice: '2400.00',
        currency: 'USD',
      },
      {
        id: ids.products.support,
        sku: 'SUP-PRIO-03',
        name: 'Priority support, annual',
        description: 'Priority response times for one year.',
        category: 'Support',
        unitPrice: '600.00',
        currency: 'USD',
      },
      {
        id: ids.products.unblocked,
        sku: 'LIC-LEGACY-04',
        name: 'Legacy licence, discontinued',
        description: 'Superseded by the team licence; nothing open references it.',
        category: 'Licences',
        unitPrice: '900.00',
        currency: 'USD',
      },
      {
        id: ids.products.closedOrderOnly,
        sku: 'SRV-PILOT-05',
        name: 'One-time pilot engagement',
        description: 'A single delivered engagement; its only order is fulfilled.',
        category: 'Services',
        unitPrice: '450.00',
        currency: 'USD',
      },
    ] as const;

    for (const product of products) {
      await tx.product.upsert({
        where: { id: product.id },
        update: { ...product, deletedAt: null, isActive: true },
        create: product,
      });
    }

    const warehouses = [
      { id: ids.warehouses.central, code: 'CENTRAL', name: 'Central warehouse' },
      { id: ids.warehouses.regional, code: 'REGIONAL', name: 'Regional warehouse' },
    ] as const;

    for (const warehouse of warehouses) {
      await tx.warehouse.upsert({
        where: { id: warehouse.id },
        update: { ...warehouse, isActive: true },
        create: warehouse,
      });
    }

    const stockLevels = [
      {
        warehouseId: ids.warehouses.central,
        productId: ids.products.licence,
        quantityOnHand: 120,
        quantityReserved: 10,
      },
      {
        warehouseId: ids.warehouses.central,
        productId: ids.products.support,
        quantityOnHand: 80,
        quantityReserved: 0,
      },
      {
        warehouseId: ids.warehouses.regional,
        productId: ids.products.workshop,
        quantityOnHand: 15,
        quantityReserved: 3,
      },
      {
        warehouseId: ids.warehouses.central,
        productId: ids.products.unblocked,
        quantityOnHand: 6,
        quantityReserved: 0,
      },
      {
        warehouseId: ids.warehouses.central,
        productId: ids.products.closedOrderOnly,
        quantityOnHand: 4,
        quantityReserved: 0,
      },
    ] as const;

    for (const level of stockLevels) {
      await tx.stockLevel.upsert({
        where: {
          warehouseId_productId: {
            warehouseId: level.warehouseId,
            productId: level.productId,
          },
        },
        update: { ...level, version: 1 },
        create: { ...level, version: 1 },
      });
    }

    const orders = [
      {
        id: ids.orders.confirmed,
        orderNumber: 'ORD-2026-0001',
        ownerId: ids.users.manager,
        contactId: ids.contacts.northwind,
        dealId: ids.deals.onboarding,
        status: OrderStatus.CONFIRMED,
        currency: 'USD',
        subtotal: '1800.00',
        discountTotal: '0.00',
        taxTotal: '0.00',
        total: '1800.00',
        placedAt: new Date('2026-02-01T09:00:00.000Z'),
        version: 1,
      },
      {
        id: ids.orders.draft,
        orderNumber: 'ORD-2026-0002',
        ownerId: ids.users.viewer,
        contactId: ids.contacts.cedarLabs,
        dealId: null,
        status: OrderStatus.DRAFT,
        currency: 'USD',
        subtotal: '2400.00',
        discountTotal: '0.00',
        taxTotal: '0.00',
        total: '2400.00',
        placedAt: null,
        version: 1,
      },
      {
        id: ids.orders.fulfilled,
        orderNumber: 'ORD-2026-0003',
        ownerId: ids.users.manager,
        contactId: ids.contacts.bluePeak,
        dealId: null,
        status: OrderStatus.FULFILLED,
        currency: 'USD',
        subtotal: '450.00',
        discountTotal: '0.00',
        taxTotal: '0.00',
        total: '450.00',
        placedAt: new Date('2026-01-15T09:00:00.000Z'),
        version: 1,
      },
    ] as const;

    for (const order of orders) {
      await tx.order.upsert({
        where: { id: order.id },
        update: { ...order, deletedAt: null },
        create: order,
      });
    }

    const orderItems = [
      {
        id: ids.orderItems.confirmedLicence,
        orderId: ids.orders.confirmed,
        productId: ids.products.licence,
        sku: 'LIC-TEAM-01',
        name: 'Team licence, annual',
        quantity: 1,
        unitPrice: '1200.00',
        lineTotal: '1200.00',
      },
      {
        id: ids.orderItems.confirmedSupport,
        orderId: ids.orders.confirmed,
        productId: ids.products.support,
        sku: 'SUP-PRIO-03',
        name: 'Priority support, annual',
        quantity: 1,
        unitPrice: '600.00',
        lineTotal: '600.00',
      },
      {
        id: ids.orderItems.draftWorkshop,
        orderId: ids.orders.draft,
        productId: ids.products.workshop,
        sku: 'SRV-WS-02',
        name: 'Onboarding workshop',
        quantity: 1,
        unitPrice: '2400.00',
        lineTotal: '2400.00',
      },
      {
        id: ids.orderItems.fulfilledClosedOrderOnly,
        orderId: ids.orders.fulfilled,
        productId: ids.products.closedOrderOnly,
        sku: 'SRV-PILOT-05',
        name: 'One-time pilot engagement',
        quantity: 1,
        unitPrice: '450.00',
        lineTotal: '450.00',
      },
    ] as const;

    for (const item of orderItems) {
      await tx.orderItem.upsert({
        where: { id: item.id },
        update: item,
        create: item,
      });
    }

    const settings = [
      {
        key: 'organization.name',
        value: 'Training CRM',
        description: 'Display name of the organization.',
      },
      {
        key: 'organization.defaultCurrency',
        value: 'USD',
        description: 'Currency applied to new orders and deals.',
      },
      {
        key: 'orders.numberPrefix',
        value: 'ORD',
        description: 'Prefix used when generating order numbers.',
      },
      {
        key: 'warehouse.defaultCode',
        value: 'CENTRAL',
        description: 'Warehouse used when a request does not name one.',
      },
    ] as const;

    for (const setting of settings) {
      await tx.organizationSetting.upsert({
        where: { key: setting.key },
        update: { value: setting.value, description: setting.description },
        create: { key: setting.key, value: setting.value, description: setting.description },
      });
    }
  });
}

main()
  .catch((error: unknown) => {
    console.error('Database seed failed.', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
