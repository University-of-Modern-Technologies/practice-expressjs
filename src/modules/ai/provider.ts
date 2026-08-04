import { AppError } from '../../common/errors/app-error.js';

/**
 * Provider-agnostic port for text completion.
 *
 * Everything above this interface — prompt building, validation, caching — is
 * written once and works with the offline mock, with an HTTP endpoint, or with
 * whatever comes next. The port is deliberately tiny: no streaming, no tools,
 * no message history. A narrow port is a port that is easy to fake.
 */
export interface AiCompletionRequest {
  /** Instructions from us. Never contains user-supplied text. */
  readonly system: string;
  /** Task payload; user-supplied text appears here only inside delimiters. */
  readonly prompt: string;
  /** Hard upper bound on the answer, so one call cannot run away with cost. */
  readonly maxTokens: number;
}

export interface AiProvider {
  /** Identifies the implementation in responses and logs. */
  readonly name: string;
  complete(request: AiCompletionRequest): Promise<string>;
}

export const AI_TIMEOUT = 'AI_TIMEOUT';
export const AI_UNAVAILABLE = 'AI_UNAVAILABLE';
export const AI_INVALID_RESPONSE = 'AI_INVALID_RESPONSE';
export const AI_INPUT_TOO_LARGE = 'AI_INPUT_TOO_LARGE';

export const aiTimeoutError = (): AppError =>
  new AppError('The assistant did not respond in time', 504, AI_TIMEOUT);

export const aiUnavailableError = (): AppError =>
  new AppError('The assistant is temporarily unavailable', 503, AI_UNAVAILABLE);

export const aiInvalidResponseError = (): AppError =>
  new AppError('The assistant returned an unexpected payload', 502, AI_INVALID_RESPONSE);

export const aiInputTooLargeError = (maxChars: number): AppError =>
  new AppError(`Input exceeds the ${maxChars} character limit`, 400, AI_INPUT_TOO_LARGE);
