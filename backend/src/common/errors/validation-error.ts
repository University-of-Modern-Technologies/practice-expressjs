import { AppError } from './app-error.js';

/**
 * The refusal of a request whose input fails its schema: 400 with the code a
 * client checks for and the details of what failed. Controllers that validate
 * inside the handler throw it, so all of them answer alike.
 */
export const validationError = (details: unknown): AppError =>
  new AppError('Invalid request', 400, 'VALIDATION_ERROR', details);
