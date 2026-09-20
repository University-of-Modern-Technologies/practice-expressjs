import { describe, expect, it, jest } from '@jest/globals';
import type { Logger } from 'pino';

import { createCallProvider } from './provider-factory.js';
import { HTTP_CALL_PROVIDER_NAME } from './http-provider.js';
import { STUB_CALL_PROVIDER_NAME } from './stub-provider.js';

const loggerWith = (warn: jest.Mock): Logger => ({ warn }) as unknown as Logger;

describe('call provider selection', () => {
  it('uses the offline stub when no address is configured', () => {
    expect(createCallProvider().name).toBe(STUB_CALL_PROVIDER_NAME);
    expect(createCallProvider({ config: { baseUrl: '' } }).name).toBe(STUB_CALL_PROVIDER_NAME);
  });

  it('uses the configured switchboard once an address is given', () => {
    expect(createCallProvider({ config: { baseUrl: 'https://telephony.invalid' } }).name).toBe(
      HTTP_CALL_PROVIDER_NAME,
    );
  });

  it('says once per logger that the journal it serves is generated', () => {
    const warn = jest.fn();
    const logger = loggerWith(warn);

    createCallProvider({ logger });
    createCallProvider({ logger });

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
