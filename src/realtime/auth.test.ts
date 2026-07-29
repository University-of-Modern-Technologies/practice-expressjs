import { extractAccessToken } from './auth.js';

describe('extractAccessToken', () => {
  it('reads the Authorization bearer header', () => {
    expect(extractAccessToken({ authorization: 'Bearer token-1' })).toBe('token-1');
    expect(extractAccessToken({ authorization: 'bearer token-2' })).toBe('token-2');
  });

  it('reads the bearer marker subprotocol pair', () => {
    expect(extractAccessToken({ 'sec-websocket-protocol': 'bearer, token-3' })).toBe('token-3');
  });

  it('reads the prefixed subprotocol form', () => {
    expect(extractAccessToken({ 'sec-websocket-protocol': 'access_token.token-4' })).toBe(
      'token-4',
    );
  });

  it('prefers the Authorization header over the subprotocol', () => {
    expect(
      extractAccessToken({
        authorization: 'Bearer header-token',
        'sec-websocket-protocol': 'bearer, protocol-token',
      }),
    ).toBe('header-token');
  });

  it('never reads a token from the query string', () => {
    // The gateway only ever passes headers here; this asserts the contract.
    expect(extractAccessToken({})).toBeNull();
    expect(extractAccessToken({ authorization: 'Basic abc' })).toBeNull();
    expect(extractAccessToken({ 'sec-websocket-protocol': 'bearer' })).toBeNull();
    expect(extractAccessToken({ 'sec-websocket-protocol': 'access_token.' })).toBeNull();
  });
});
