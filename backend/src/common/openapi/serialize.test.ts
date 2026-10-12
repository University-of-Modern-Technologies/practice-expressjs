import { describe, expect, it } from '@jest/globals';

import { serializeOpenApiDocument } from './serialize.js';

describe('serializeOpenApiDocument', () => {
  it('sorts keys at every level and keeps the order of arrays', () => {
    const text = serializeOpenApiDocument({
      paths: { '/b': { post: {}, get: {} }, '/a': {} },
      openapi: '3.1.0',
      required: ['zeta', 'alpha'],
    });

    expect(text).toBe(
      [
        '{',
        '  "openapi": "3.1.0",',
        '  "paths": {',
        '    "/a": {},',
        '    "/b": {',
        '      "get": {},',
        '      "post": {}',
        '    }',
        '  },',
        '  "required": [',
        '    "zeta",',
        '    "alpha"',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('renders the same bytes however the keys were inserted', () => {
    expect(serializeOpenApiDocument({ a: 1, b: { c: 2, d: 3 } })).toBe(
      serializeOpenApiDocument({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });
});
