import { describe, expect, it } from '@jest/globals';

import { AppError } from './app-error.js';
import { validationError } from './validation-error.js';

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
