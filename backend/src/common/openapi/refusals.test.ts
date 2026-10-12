import { describe, expect, it } from '@jest/globals';

import { refusals, RESPONSE_DESCRIPTIONS } from './refusals.js';
import { errorResponseSchema } from './schemas.js';

describe('refusals', () => {
  it('describes every declared status inline, with the error envelope', () => {
    const declared = refusals(401, 404, 409, 422);

    expect(Object.keys(declared)).toEqual(['401', '404', '409', '422']);
    expect(declared['404']).toEqual({
      description: RESPONSE_DESCRIPTIONS[404],
      content: { 'application/json': { schema: errorResponseSchema } },
    });
  });

  it('declares nothing for an operation that refuses with nothing but 400 and 500', () => {
    expect(refusals()).toEqual({});
  });
});
