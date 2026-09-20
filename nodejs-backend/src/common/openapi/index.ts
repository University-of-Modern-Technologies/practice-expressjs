import { aiPaths } from './ai.paths.js';
import { analyticsPaths } from './analytics.paths.js';
import { auditPaths } from './audit.paths.js';
import { authPaths } from './auth.paths.js';
import { openApiComponents } from './components.js';
import { callsPaths } from './calls.paths.js';
import { contactsPaths } from './contacts.paths.js';
import { dealsPaths } from './deals.paths.js';
import { helpdeskPaths } from './helpdesk.paths.js';
import { integrationsPaths } from './integrations.paths.js';
import { ordersPaths } from './orders.paths.js';
import { productsPaths } from './products.paths.js';
import { rbacPaths } from './rbac.paths.js';
import { settingsPaths } from './settings.paths.js';
import { usersPaths } from './users.paths.js';
import { warehousePaths } from './warehouse.paths.js';

const healthPaths = {
  '/health/live': {
    get: {
      tags: ['Health'],
      summary: 'Перевірити працездатність процесу',
      responses: {
        '200': {
          description: 'Процес працює',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: { status: { type: 'string', enum: ['ok'] } },
              },
            },
          },
        },
      },
    },
  },
  '/health/ready': {
    get: {
      tags: ['Health'],
      summary: 'Перевірити готовність приймати трафік',
      responses: {
        '200': { description: 'Сервіс готовий' },
        '503': { description: 'Одна або кілька залежностей недоступні' },
      },
    },
  },
} as const;

export const openApiDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'Practice CRM API',
    version: '1.0.0',
    description: 'HTTP API навчальної CRM-системи.',
  },
  tags: [
    { name: 'Health', description: 'Перевірки стану сервісу' },
    { name: 'Auth', description: 'Автентифікація та токени' },
    { name: 'Users', description: 'Користувачі системи' },
    { name: 'Sessions', description: 'Refresh-сесії користувачів' },
    { name: 'RBAC', description: 'Перевірка дозволів' },
    { name: 'Roles', description: 'Ролі та їхні дозволи' },
    { name: 'Contacts', description: 'Контакти CRM' },
    { name: 'Deals', description: 'Угоди CRM' },
    { name: 'Helpdesk', description: 'Звернення клієнтів' },
    { name: 'Deal transitions', description: 'Переходи угод між stage' },
    { name: 'Helpdesk transitions', description: 'Переходи звернень між станами' },
    { name: 'Calls', description: 'Журнал дзвінків' },
    { name: 'Audit', description: 'Журнал аудиту' },
    { name: 'Resource history', description: 'Історія змін ресурсу' },
    { name: 'Products', description: 'Каталог товарів' },
    { name: 'Orders', description: 'Замовлення' },
    { name: 'Order items', description: 'Рядки замовлення' },
    { name: 'Order transitions', description: 'Переходи замовлень між статусами' },
    { name: 'Warehouses', description: 'Склади' },
    { name: 'Stock', description: 'Рівні запасів та складські операції' },
    { name: 'Stock movements', description: 'Журнал рухів запасів' },
    { name: 'Settings', description: 'Налаштування організації' },
    { name: 'Analytics', description: 'Аналітичні звіти' },
    { name: 'Integrations', description: 'Стан зовнішніх інтеграцій' },
    { name: 'Delivery', description: 'Доставка: тарифи та відправлення' },
    { name: 'AI', description: 'Асистент: стислі описи та класифікація' },
  ],
  components: openApiComponents,
  paths: {
    ...healthPaths,
    ...authPaths,
    ...usersPaths,
    ...rbacPaths,
    ...contactsPaths,
    ...dealsPaths,
    ...helpdeskPaths,
    ...callsPaths,
    ...auditPaths,
    ...productsPaths,
    ...ordersPaths,
    ...warehousePaths,
    ...settingsPaths,
    ...analyticsPaths,
    ...integrationsPaths,
    ...aiPaths,
  },
} as const;
