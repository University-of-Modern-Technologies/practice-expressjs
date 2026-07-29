import pinoHttp, { type HttpLogger } from 'pino-http';
import type { Logger } from 'pino';

import { REQUEST_ID_HEADER, isSafeRequestId, resolveRequestId } from './request-id.js';

export const createRequestLogger = (logger: Logger): HttpLogger =>
  pinoHttp({
    logger,
    genReqId(request, response) {
      // `createRequestId` may already have assigned an id upstream; reuse it so
      // the header, the access log and the error envelope all agree.
      const requestId = isSafeRequestId(request.id)
        ? request.id
        : resolveRequestId(request.headers[REQUEST_ID_HEADER]);

      response.setHeader(REQUEST_ID_HEADER, requestId);
      return requestId;
    },
    customLogLevel(_request, response, error) {
      if (error || response.statusCode >= 500) return 'error';
      if (response.statusCode >= 400) return 'warn';
      return 'info';
    },
  });
