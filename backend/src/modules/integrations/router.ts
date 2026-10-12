import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import { created, describeRoutes, ok, refusals } from '../../common/openapi/index.js';
import { requirePermission } from '../rbac/middleware.js';
import type { RbacService } from '../rbac/service.js';
import type { IntegrationsController } from './controller.js';
import { deliveryHealthSchema, deliveryQuoteSchema, shipmentSchema } from './types.js';
import { createQuoteSchema, createShipmentSchema, getShipmentSchema } from './validation.js';

const upstreamErrorNote =
  'Помилки зовнішньої служби: 422 `DELIVERY_REJECTED`, 502 `DELIVERY_INVALID_RESPONSE`, ' +
  '503 `DELIVERY_UNAVAILABLE` (зокрема коли розімкнено запобіжник), 504 `DELIVERY_TIMEOUT`.';

const orderNote =
  'Замовлення має існувати, бути видимим за обсягом дозволу `orders:read` і перебувати ' +
  'у статусі CONFIRMED або PAID: інакше 404 `ORDER_NOT_FOUND` або 409 `ORDER_NOT_SHIPPABLE`.';

export const createIntegrationsRouter = (
  controller: IntegrationsController,
  authenticate: RequestHandler,
  rbacService: RbacService,
): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [
    { name: 'Integrations', description: 'Стан зовнішніх інтеграцій' },
    { name: 'Delivery', description: 'Доставка: тарифи та відправлення' },
  ]);

  // The grant is checked before the request is validated, so a caller without
  // access is refused the same way whatever they sent. Any breadth admits the
  // caller here; what that breadth lets them touch is the service's business.
  const allowed = (action: 'read' | 'write'): RequestHandler =>
    requirePermission(rbacService, {
      resource: 'integrations',
      action,
      ownerId: (request) => request.auth?.userId,
    });

  routes.get(
    '/health',
    {
      summary: 'Стан інтеграції доставки',
      description:
        'Потребує дозволу `integrations:read`. Повертає транспорт і стан запобіжника без ' +
        'жодних даних про зовнішню службу.',
      response: ok('Стан інтеграції', deliveryHealthSchema),
      refusals: refusals(401, 403),
    },
    controller.health,
  );
  routes.post(
    '/delivery/quotes',
    {
      tags: ['Delivery'],
      summary: 'Запитати вартість доставки',
      description: `Потребує дозволу \`integrations:read\`. ${orderNote} Результат кешується. ${upstreamErrorNote}`,
      response: ok('Пропозиція доставки', deliveryQuoteSchema),
      // Every call to the carrier can fail in one of four documented ways.
      refusals: refusals(401, 403, 404, 409, 422, 502, 503, 504),
    },
    allowed('read'),
    validate(createQuoteSchema),
    controller.createQuote,
  );
  routes.post(
    '/delivery/shipments',
    {
      tags: ['Delivery'],
      summary: 'Створити відправлення',
      description: `Потребує дозволу \`integrations:write\`. ${orderNote} Не кешується. ${upstreamErrorNote}`,
      response: created('Відправлення створено', shipmentSchema),
      refusals: refusals(401, 403, 404, 409, 422, 502, 503, 504),
    },
    allowed('write'),
    validate(createShipmentSchema),
    controller.createShipment,
  );
  routes.get(
    '/delivery/shipments/:id',
    {
      tags: ['Delivery'],
      summary: 'Отримати стан відправлення',
      description:
        'Потребує дозволу `integrations:read`. Не кешується. Якщо зовнішня служба не знає ' +
        `такого відправлення, повертається 404 \`DELIVERY_REJECTED\`. ${upstreamErrorNote}`,
      response: ok('Відправлення', shipmentSchema),
      refusals: refusals(401, 403, 404, 422, 502, 503, 504),
    },
    allowed('read'),
    validate(getShipmentSchema),
    controller.getShipment,
  );
  return router;
};
