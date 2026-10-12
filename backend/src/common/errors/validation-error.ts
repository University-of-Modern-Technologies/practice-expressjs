import type { z } from 'zod';

import { AppError } from './app-error.js';

/**
 * The details of a refused request, in the shape both backends send:
 * `formErrors` for what belongs to the request as a whole, `fieldErrors` keyed
 * by the request part (`body`, `query`, `params`), each message prefixed with
 * the path of the field inside that part — `"email: Invalid email address"`,
 * `"items.0.quantity: Too small"`. The prefix is what lets a client put the
 * message back on the input it belongs to.
 */
export interface ValidationDetails {
  readonly formErrors: string[];
  readonly fieldErrors: Record<string, string[]>;
}

export type RequestPart = 'body' | 'query' | 'params';

/**
 * Groups schema issues by request part, folding the rest of the path into the
 * message. The schema is either the whole request (`{ body, query, params }`,
 * as `validate()` checks it) or, with `part`, the schema of that one part — a
 * controller that parses `request.query` itself passes `'query'`.
 */
export const describeValidationIssues = (
  error: z.ZodError,
  part?: RequestPart,
): ValidationDetails => {
  const formErrors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const [head, ...rest] = part === undefined ? issue.path : [part, ...issue.path];
    if (head === undefined) {
      formErrors.push(issue.message);
      continue;
    }
    const field = rest.map(String).join('.');
    (fieldErrors[String(head)] ??= []).push(field ? `${field}: ${issue.message}` : issue.message);
  }

  return { formErrors, fieldErrors };
};

/**
 * The refusal of a request whose input fails its schema: 400 with the code a
 * client checks for and the details of what failed. Controllers that validate
 * inside the handler throw it, so all of them answer alike.
 */
export const validationError = (details: unknown): AppError =>
  new AppError('Invalid request', 400, 'VALIDATION_ERROR', details);
