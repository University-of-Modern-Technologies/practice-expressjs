import {
  createDocument,
  type ZodOpenApiObject,
  type ZodOpenApiOverride,
  type ZodOpenApiPathsObject,
} from 'zod-openapi';

import { openApiSecuritySchemes } from './components.js';
import { toOperationObject } from './operations.js';
import { declaredTags, describedOperations, type MountedRouter } from './routes.js';
import { errorResponseSchema } from './schemas.js';

/** Formats Zod renders together with the regex it checks them with. */
const NAMED_FORMATS = new Set(['uuid', 'email', 'date-time', 'date', 'time', 'uri']);

/**
 * Adjusts what Zod renders to what travels on the wire and what a reader of the
 * description needs, without touching the schemas that validate requests.
 */
const renderForTheWire: ZodOpenApiOverride = ({ jsonSchema, zodSchema, io }) => {
  const { def } = zodSchema._zod;

  // Dates leave the service as `Date` and reach the client as ISO strings.
  if (def.type === 'date') {
    jsonSchema.type = 'string';
    jsonSchema.format = 'date-time';
  }

  // A named format already says what the regex Zod checks it with says.
  if (typeof jsonSchema.format === 'string' && NAMED_FORMATS.has(jsonSchema.format)) {
    delete jsonSchema.pattern;
  }

  // `.int()` bounds a number by the safe integer range; that is a property of
  // JavaScript, not a rule of the API.
  if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
  if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum;

  // Zod states no default for a field whose default follows a transform, though
  // a caller who omits it still gets one; a plain value is stated here instead.
  // It is done on the enclosing object, which sees every field once it is final.
  if (io === 'input' && def.type === 'object') {
    for (const [key, field] of Object.entries(def.shape)) {
      const property = jsonSchema.properties?.[key];
      const fieldDef = field._zod.def;
      if (typeof property !== 'object' || '$ref' in property || property.default !== undefined) {
        continue;
      }
      if (fieldDef.type !== 'default') continue;
      const value: unknown = (fieldDef as { defaultValue?: unknown }).defaultValue;
      if (['string', 'number', 'boolean'].includes(typeof value)) property.default = value;
    }
  }

  // Responses are not closed to new fields: adding one is not a breaking change.
  if (io === 'output' && jsonSchema.additionalProperties === false) {
    delete jsonSchema.additionalProperties;
  }
};

export const API_INFO = {
  title: 'Practice CRM API',
  version: '1.0.0',
  description: 'HTTP API навчальної CRM-системи.',
} as const;

/**
 * Builds the description by walking the mounted routers: every route that was
 * registered through `describeRoutes()` becomes an operation, and nothing else
 * does.
 */
export const buildOpenApiDocument = (
  mounted: readonly MountedRouter[],
): ReturnType<typeof createDocument> => {
  const paths: ZodOpenApiPathsObject = {};
  for (const described of describedOperations(mounted)) {
    paths[described.path] = {
      ...paths[described.path],
      [described.method]: toOperationObject(described),
    };
  }

  const document: ZodOpenApiObject = {
    openapi: '3.1.0',
    info: { ...API_INFO },
    tags: declaredTags(mounted).map(({ name, description }) => ({ name, description })),
    components: {
      securitySchemes: openApiSecuritySchemes,
      schemas: { ErrorResponse: errorResponseSchema },
    },
    paths,
  };

  return createDocument(document, { override: renderForTheWire });
};
