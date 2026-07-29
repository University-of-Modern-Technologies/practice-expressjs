import { describe, expect, it } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';

import {
  createRequestId,
  isSafeRequestId,
  MAX_REQUEST_ID_LENGTH,
  REQUEST_ID_HEADER,
  resolveRequestId,
} from './request-id.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const createTestApp = (...handlers: express.RequestHandler[]): Express => {
  const app = express();
  app.use(...(handlers.length > 0 ? handlers : [createRequestId()]));
  app.get('/echo', (request_, response) => {
    response.json({ id: request_.id });
  });

  return app;
};

describe('isSafeRequestId', () => {
  it.each(['abc', '0123456789', 'a-b_c.d:e', '1f9a4c7e-0e0b-4f2f-9a1d-5f6f2f3a4b5c'])(
    'accepts %s',
    (value) => {
      expect(isSafeRequestId(value)).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['whitespace', 'has space'],
    ['crlf injection', 'abc\r\nSet-Cookie: a=b'],
    ['null byte', `abc${String.fromCharCode(0)}def`],
    ['bell character', `abc${String.fromCharCode(7)}def`],
    ['slash', 'a/b'],
    ['unicode', 'idентифікатор'],
    ['angle brackets', '<script>alert(1)</script>'],
    ['too long', 'a'.repeat(MAX_REQUEST_ID_LENGTH + 1)],
    ['not a string', 42],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isSafeRequestId(value)).toBe(false);
  });
});

describe('resolveRequestId', () => {
  it('generates a UUID v4 when the header is missing', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID_V4);
  });

  it('generates a fresh id for duplicated headers', () => {
    expect(resolveRequestId(['first', 'second'])).toMatch(UUID_V4);
  });

  it('trims surrounding whitespace', () => {
    expect(resolveRequestId('  abc  ')).toBe('abc');
  });
});

describe('createRequestId middleware', () => {
  it('generates a UUID v4 and echoes it on the response', async () => {
    const response = await request(createTestApp()).get('/echo');

    expect(response.status).toBe(200);
    expect(response.body.id).toMatch(UUID_V4);
    expect(response.headers[REQUEST_ID_HEADER]).toBe(response.body.id);
  });

  it('generates a distinct id per request', async () => {
    const app = createTestApp();

    const first = await request(app).get('/echo');
    const second = await request(app).get('/echo');

    expect(first.body.id).not.toBe(second.body.id);
  });

  it('passes a safe inbound id through unchanged', async () => {
    const response = await request(createTestApp())
      .get('/echo')
      .set(REQUEST_ID_HEADER, 'client-correlation-42');

    expect(response.body.id).toBe('client-correlation-42');
    expect(response.headers[REQUEST_ID_HEADER]).toBe('client-correlation-42');
  });

  it('never echoes an unsafe inbound id', async () => {
    const response = await request(createTestApp())
      .get('/echo')
      .set(REQUEST_ID_HEADER, '<script>alert(1)</script>');

    expect(response.body.id).toMatch(UUID_V4);
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID_V4);
  });

  it('never echoes an oversized inbound id', async () => {
    const response = await request(createTestApp())
      .get('/echo')
      .set(REQUEST_ID_HEADER, 'a'.repeat(4_096));

    expect(response.body.id).toMatch(UUID_V4);
  });

  it('ignores inbound ids when the header is not trusted', async () => {
    const app = createTestApp(createRequestId({ trustInboundHeader: false }));

    const response = await request(app).get('/echo').set(REQUEST_ID_HEADER, 'client-supplied');

    expect(response.body.id).toMatch(UUID_V4);
  });

  it('supports a custom header name and length limit', async () => {
    const app = createTestApp(createRequestId({ header: 'x-correlation-id', maxLength: 8 }));

    const short = await request(app).get('/echo').set('x-correlation-id', 'abcdefgh');
    expect(short.body.id).toBe('abcdefgh');
    expect(short.headers['x-correlation-id']).toBe('abcdefgh');

    const long = await request(app).get('/echo').set('x-correlation-id', 'abcdefghi');
    expect(long.body.id).toMatch(UUID_V4);
  });
});
