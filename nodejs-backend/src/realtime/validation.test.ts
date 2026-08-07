import { REALTIME_ERROR_CODES } from './types.js';
import { decodeInboundFrame, parseInboundMessage, readInboundFrame } from './validation.js';

describe('decodeInboundFrame', () => {
  it('decodes string, Buffer and ArrayBuffer payloads', () => {
    expect(decodeInboundFrame('hi', 64)).toEqual({ ok: true, text: 'hi' });
    expect(decodeInboundFrame(Buffer.from('hi'), 64)).toEqual({ ok: true, text: 'hi' });

    const bytes = new Uint8Array([104, 105]);
    expect(decodeInboundFrame(bytes.buffer, 64)).toEqual({ ok: true, text: 'hi' });
    expect(decodeInboundFrame([Buffer.from('h'), Buffer.from('i')], 64)).toEqual({
      ok: true,
      text: 'hi',
    });
  });

  it('enforces the inbound size limit', () => {
    const result = decodeInboundFrame('x'.repeat(20), 8);
    expect(result).toMatchObject({ ok: false, code: REALTIME_ERROR_CODES.messageTooLarge });
  });
});

describe('parseInboundMessage', () => {
  it('accepts subscribe, unsubscribe and ping frames', () => {
    expect(parseInboundMessage('{"type":"subscribe","topic":"deals"}')).toEqual({
      ok: true,
      message: { type: 'subscribe', topic: 'deals' },
    });
    expect(parseInboundMessage('{"type":"unsubscribe","topic":"entity:order:o1"}')).toEqual({
      ok: true,
      message: { type: 'unsubscribe', topic: 'entity:order:o1' },
    });
    expect(parseInboundMessage('{"type":"ping"}')).toEqual({
      ok: true,
      message: { type: 'ping' },
    });
  });

  it('rejects malformed JSON', () => {
    expect(parseInboundMessage('{')).toMatchObject({
      ok: false,
      code: REALTIME_ERROR_CODES.invalidMessage,
    });
  });

  it('rejects unknown message types and extra keys', () => {
    expect(parseInboundMessage('{"type":"drop-tables"}')).toMatchObject({
      ok: false,
      code: REALTIME_ERROR_CODES.invalidMessage,
    });
    expect(parseInboundMessage('{"type":"subscribe","topic":"deals","admin":true}')).toMatchObject({
      ok: false,
      code: REALTIME_ERROR_CODES.invalidMessage,
    });
  });

  it('rejects unknown topics with a dedicated code', () => {
    expect(parseInboundMessage('{"type":"subscribe","topic":"secrets"}')).toMatchObject({
      ok: false,
      code: REALTIME_ERROR_CODES.unknownTopic,
    });
  });

  it('never throws on hostile input', () => {
    for (const payload of ['null', '[]', '"string"', '123', '{"type":null}', '{}']) {
      expect(() => parseInboundMessage(payload)).not.toThrow();
      expect(parseInboundMessage(payload).ok).toBe(false);
    }
  });
});

describe('readInboundFrame', () => {
  it('combines decoding and validation', () => {
    expect(readInboundFrame(Buffer.from('{"type":"ping"}'), 64)).toEqual({
      ok: true,
      message: { type: 'ping' },
    });
    expect(readInboundFrame(Buffer.from('{"type":"ping"}'), 4)).toMatchObject({
      ok: false,
      code: REALTIME_ERROR_CODES.messageTooLarge,
    });
  });
});
