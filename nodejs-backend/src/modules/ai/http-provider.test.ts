import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/app-error.js';
import {
  createHttpAiProvider,
  type AiTransport,
  type AiTransportResponse,
} from './http-provider.js';
import { AI_INVALID_RESPONSE, AI_TIMEOUT, AI_UNAVAILABLE } from './provider.js';

interface FakeTransport extends AiTransport {
  readonly calls: number;
  readonly bodies: unknown[];
}

const fakeTransport = (script: ReadonlyArray<AiTransportResponse | Error>): FakeTransport => {
  let index = 0;
  const bodies: unknown[] = [];
  return {
    get calls() {
      return index;
    },
    bodies,
    send({ body }) {
      bodies.push(body);
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next as AiTransportResponse);
    },
  };
};

const timeoutError = (): Error => {
  const error = new Error('aborted');
  error.name = 'TimeoutError';
  return error;
};

const request = { system: 'sys', prompt: 'p', maxTokens: 32 };

const providerFor = (transport: AiTransport, maxAttempts = 2) =>
  createHttpAiProvider({
    endpointUrl: 'https://example.invalid/complete',
    transport,
    maxAttempts,
    delay: () => Promise.resolve(),
  });

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('Expected the call to reject');
};

describe('http ai provider', () => {
  it('returns the validated completion text', async () => {
    const provider = providerFor(fakeTransport([{ status: 200, body: { text: 'hello' } }]));

    await expect(provider.complete(request)).resolves.toBe('hello');
  });

  it('forwards the bounded token budget to the endpoint', async () => {
    const transport = fakeTransport([{ status: 200, body: { text: 'hello' } }]);
    await providerFor(transport).complete(request);

    expect(transport.bodies[0]).toMatchObject({ max_tokens: 32, system: 'sys', prompt: 'p' });
  });

  it('retries a 5xx and then succeeds', async () => {
    const transport = fakeTransport([
      { status: 500, body: undefined },
      { status: 200, body: { text: 'hello' } },
    ]);

    await expect(providerFor(transport).complete(request)).resolves.toBe('hello');
    expect(transport.calls).toBe(2);
  });

  it('does not retry a 400', async () => {
    const transport = fakeTransport([{ status: 400, body: { error: 'bad prompt' } }]);

    await expect(codeOf(providerFor(transport).complete(request))).resolves.toBe(AI_UNAVAILABLE);
    expect(transport.calls).toBe(1);
  });

  it('translates an exhausted timeout into AI_TIMEOUT', async () => {
    const transport = fakeTransport([timeoutError()]);

    await expect(codeOf(providerFor(transport).complete(request))).resolves.toBe(AI_TIMEOUT);
    expect(transport.calls).toBe(2);
  });

  it('rejects a payload that does not match the contract', async () => {
    const transport = fakeTransport([{ status: 200, body: { output: 'wrong field' } }]);

    await expect(codeOf(providerFor(transport).complete(request))).resolves.toBe(
      AI_INVALID_RESPONSE,
    );
    // A contract violation is not transient, so it is not retried.
    expect(transport.calls).toBe(1);
  });

  it('never opens a socket when a transport is injected', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await providerFor(fakeTransport([{ status: 200, body: { text: 'hello' } }])).complete(request);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
