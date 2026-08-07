import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import type { AiController } from './controller.js';
import { classifyInquirySchema, summariseDealSchema } from './validation.js';

export const createAiRouter = (controller: AiController, authenticate: RequestHandler): Router => {
  const router = Router();
  router.use(authenticate);
  router.post('/summaries/deal', validate(summariseDealSchema), controller.summariseDeal);
  router.post('/classify/inquiry', validate(classifyInquirySchema), controller.classifyInquiry);
  return router;
};
