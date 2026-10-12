import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import { validate } from '../../common/middleware/validate.js';
import { describeRoutes, noContent, ok, refusals } from '../../common/openapi/index.js';
import { requirePermission } from '../rbac/middleware.js';
import type { RbacService } from '../rbac/service.js';
import type { SettingsController } from './controller.js';
import { settingSchema } from './types.js';
import { deleteSettingSchema, getSettingSchema, upsertSettingSchema } from './validation.js';

const unknownKeyNote = 'Ключ поза реєстром дає 400 `UNKNOWN_SETTING_KEY`.';

export const createSettingsRouter = (
  controller: SettingsController,
  authenticate: RequestHandler,
  rbacService: RbacService,
): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [
    { name: 'Settings', description: 'Налаштування організації' },
  ]);

  const canRead = requirePermission(rbacService, { resource: 'settings', action: 'read' });
  const canWrite = requirePermission(rbacService, { resource: 'settings', action: 'write' });

  routes.get(
    '/',
    {
      summary: 'Переглянути всі налаштування організації',
      description:
        'Потребує дозволу `settings:read`. Повертає значення для кожного оголошеного ключа; ' +
        'якщо рядка ще немає, віддається значення за замовчуванням із `source: "default"`.',
      response: ok('Перелік налаштувань', z.array(settingSchema)),
      refusals: refusals(401, 403),
    },
    canRead,
    controller.list,
  );
  routes.get(
    '/:key',
    {
      summary: 'Отримати налаштування за ключем',
      description: `Потребує дозволу \`settings:read\`. ${unknownKeyNote}`,
      response: ok('Налаштування', settingSchema),
      refusals: refusals(401, 403),
    },
    canRead,
    validate(getSettingSchema),
    controller.getByKey,
  );
  routes.put(
    '/:key',
    {
      summary: 'Записати значення налаштування',
      description:
        'Потребує дозволу `settings:write`. Значення перевіряється схемою, оголошеною для ' +
        `цього ключа: невідповідність дає 400 \`INVALID_SETTING_VALUE\`. ${unknownKeyNote}`,
      response: ok('Налаштування збережено', settingSchema),
      refusals: refusals(401, 403),
    },
    canWrite,
    validate(upsertSettingSchema),
    controller.upsert,
  );
  routes.delete(
    '/:key',
    {
      summary: 'Скинути налаштування до значення за замовчуванням',
      description:
        'Потребує дозволу `settings:write`. Видаляє рядок, після чого читання повертає ' +
        `значення з реєстру. Помилки: 404 \`SETTING_NOT_FOUND\`. ${unknownKeyNote}`,
      response: noContent('Налаштування скинуто'),
      refusals: refusals(401, 403, 404),
    },
    canWrite,
    validate(deleteSettingSchema),
    controller.remove,
  );

  return router;
};
