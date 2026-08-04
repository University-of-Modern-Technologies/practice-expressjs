import { describe, expect, it, jest } from '@jest/globals';
import type { Logger } from 'pino';

import { HTTP_AI_PROVIDER_NAME } from './http-provider.js';
import { MOCK_AI_PROVIDER_NAME } from './mock-provider.js';
import { createAiProvider } from './provider-factory.js';

const fakeLogger = (): Logger => ({ warn: jest.fn(), error: jest.fn() }) as unknown as Logger;

describe('ai provider selection', () => {
  it('uses the mock provider when nothing is configured', () => {
    expect(createAiProvider().name).toBe(MOCK_AI_PROVIDER_NAME);
    expect(createAiProvider({ config: {} }).name).toBe(MOCK_AI_PROVIDER_NAME);
    expect(createAiProvider({ config: { endpointUrl: '' } }).name).toBe(MOCK_AI_PROVIDER_NAME);
  });

  it('warns exactly once about running on the mock', () => {
    const logger = fakeLogger();

    createAiProvider({ logger });
    createAiProvider({ logger });
    createAiProvider({ logger });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(jest.mocked(logger.warn).mock.calls[0]?.[0]).toContain('offline mock provider');
  });

  it('uses the HTTP provider once an endpoint is configured', () => {
    const provider = createAiProvider({
      config: { endpointUrl: 'https://example.invalid/complete', apiKey: 'k' },
    });

    expect(provider.name).toBe(HTTP_AI_PROVIDER_NAME);
  });

  it('does not warn when a real provider is configured', () => {
    const logger = fakeLogger();
    createAiProvider({ config: { endpointUrl: 'https://example.invalid/complete' }, logger });

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
