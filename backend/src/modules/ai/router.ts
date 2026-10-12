import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import { describeRoutes, ok, refusals } from '../../common/openapi/index.js';
import type { AiController } from './controller.js';
import { dealSummarySchema, inquiryClassificationSchema } from './types.js';
import { classifyInquirySchema, summariseDealSchema } from './validation.js';

const providerErrorNote =
  'Помилки провайдера: 502 `AI_INVALID_RESPONSE`, 503 `AI_UNAVAILABLE`, 504 `AI_TIMEOUT`. ' +
  'Текст, довший за ліміт (за замовчуванням 4000 символів), відхиляється з ' +
  '400 `AI_INPUT_TOO_LARGE`.';

export const createAiRouter = (controller: AiController, authenticate: RequestHandler): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [
    { name: 'AI', description: 'Асистент: стислі описи та класифікація' },
  ]);

  routes.post(
    '/summaries/deal',
    {
      summary: 'Скласти стислий опис угоди',
      description:
        'Потребує дозволу `ai:use`. Провайдеру передаються лише перелічені поля; усе інше ' +
        `відкидається під час валідації. Відповідь кешується. ${providerErrorNote}`,
      response: ok('Стислий опис угоди', dealSummarySchema),
      // The assistant is a remote dependency, so it fails like one.
      refusals: refusals(401, 403, 502, 503, 504),
    },
    validate(summariseDealSchema),
    controller.summariseDeal,
  );
  routes.post(
    '/classify/inquiry',
    {
      summary: 'Класифікувати звернення',
      description:
        'Потребує дозволу `ai:use`. Категорія обмежена закритим списком; відповідь поза ' +
        `списком перетворюється на \`unknown\`. Відповідь кешується. ${providerErrorNote}`,
      response: ok('Класифікація звернення', inquiryClassificationSchema),
      refusals: refusals(401, 403, 502, 503, 504),
    },
    validate(classifyInquirySchema),
    controller.classifyInquiry,
  );
  return router;
};
