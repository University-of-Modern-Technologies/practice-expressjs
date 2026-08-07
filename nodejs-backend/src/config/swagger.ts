import swaggerJsdoc from 'swagger-jsdoc';

import { openApiDefinition } from '../common/openapi/index.js';

export const openApiDocument = swaggerJsdoc({
  definition: openApiDefinition,
  apis: [],
});
