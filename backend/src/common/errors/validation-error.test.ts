import { describe, expect, it } from '@jest/globals';

import { z } from 'zod';

import { AppError } from './app-error.js';
import { describeValidationIssues, validationError } from './validation-error.js';

describe('validationError', () => {
  it('refuses with 400, the validation code and the details of what failed', () => {
    const details = { fieldErrors: { name: ['Required'] } };
    const error = validationError(details);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      message: 'Invalid request',
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      details,
    });
  });
});

describe('describeValidationIssues', () => {
  const query = z.object({ limit: z.number().max(10, { message: 'Too big' }) });

  it('places the issues of a single part under that part, field first', () => {
    const result = query.safeParse({ limit: 11 });
    if (result.success) throw new Error('expected a refusal');

    expect(describeValidationIssues(result.error, 'query')).toEqual({
      formErrors: [],
      fieldErrors: { query: ['limit: Too big'] },
    });
  });

  it('reads the first segment as the part when the schema is the whole request', () => {
    const result = z.object({ query }).safeParse({ query: { limit: 11 } });
    if (result.success) throw new Error('expected a refusal');

    expect(describeValidationIssues(result.error)).toEqual({
      formErrors: [],
      fieldErrors: { query: ['limit: Too big'] },
    });
  });

  it('keeps an issue about the whole input as a form error', () => {
    const result = query.safeParse('not an object');
    if (result.success) throw new Error('expected a refusal');

    const details = describeValidationIssues(result.error);
    expect(details.formErrors).toHaveLength(1);
    expect(details.fieldErrors).toEqual({});
  });
});
