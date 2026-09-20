import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import type { CallsController } from './controller.js';
import {
  deleteCallSchema,
  getCallRecordingSchema,
  getCallSchema,
  linkCallSchema,
  listCallsSchema,
  syncCallsSchema,
  updateCallSchema,
} from './validation.js';

/**
 * There is no `POST /` here: a call is not something this system creates, it is
 * something the switchboard already did and we import. Import is therefore its
 * own route, and the collection has no write of its own.
 */
export const createCallsRouter = (
  controller: CallsController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);
  router.get('/', validate(listCallsSchema), controller.list);
  router.post('/sync', validate(syncCallsSchema), controller.sync);
  router.get('/:id', validate(getCallSchema), controller.getById);
  router.get('/:id/recording', validate(getCallRecordingSchema), controller.getRecording);
  router.patch('/:id', validate(updateCallSchema), controller.update);
  router.post('/:id/link', validate(linkCallSchema), controller.link);
  router.delete('/:id', validate(deleteCallSchema), controller.delete);
  return router;
};
