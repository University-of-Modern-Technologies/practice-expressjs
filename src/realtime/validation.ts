import { z } from 'zod';

import { MAX_TOPIC_LENGTH, isRealtimeTopic, type RealtimeTopic } from './topics.js';
import { REALTIME_ERROR_CODES, type RawSocketData, type RealtimeErrorCode } from './types.js';

/**
 * Inbound frames are always validated before they touch any state. Nothing in
 * this module throws: every failure is reported as a typed result so the
 * gateway can answer with a structured error frame instead of crashing.
 */

export const realtimeTopicSchema = z
  .string()
  .min(1)
  .max(MAX_TOPIC_LENGTH)
  .refine(isRealtimeTopic, { message: 'Unknown topic' })
  .transform((value): RealtimeTopic => value as RealtimeTopic);

export const subscribeMessageSchema = z.strictObject({
  type: z.literal('subscribe'),
  topic: realtimeTopicSchema,
});

export const unsubscribeMessageSchema = z.strictObject({
  type: z.literal('unsubscribe'),
  topic: realtimeTopicSchema,
});

export const pingMessageSchema = z.strictObject({
  type: z.literal('ping'),
});

export const inboundMessageSchema = z.discriminatedUnion('type', [
  subscribeMessageSchema,
  unsubscribeMessageSchema,
  pingMessageSchema,
]);

export type InboundMessage = z.infer<typeof inboundMessageSchema>;
export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;

export type InboundParseResult =
  | { readonly ok: true; readonly message: InboundMessage }
  | { readonly ok: false; readonly code: RealtimeErrorCode; readonly reason: string };

/** Concatenates the transport payload into a single buffer. */
const toBuffer = (data: RawSocketData): Buffer => {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return Buffer.from(new Uint8Array(data as ArrayBuffer));
};

export type DecodeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: RealtimeErrorCode; readonly reason: string };

/** Decodes a frame to text, enforcing the inbound size limit first. */
export const decodeInboundFrame = (data: RawSocketData, maxBytes: number): DecodeResult => {
  const buffer = toBuffer(data);

  if (buffer.byteLength > maxBytes) {
    return {
      ok: false,
      code: REALTIME_ERROR_CODES.messageTooLarge,
      reason: `Message exceeds ${String(maxBytes)} bytes`,
    };
  }

  return { ok: true, text: buffer.toString('utf8') };
};

/** Parses and validates a decoded frame body. */
export const parseInboundMessage = (text: string): InboundParseResult => {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: REALTIME_ERROR_CODES.invalidMessage,
      reason: 'Message is not valid JSON',
    };
  }

  const parsed = inboundMessageSchema.safeParse(json);
  if (parsed.success) {
    return { ok: true, message: parsed.data };
  }

  const mentionsTopic = parsed.error.issues.some((issue) => issue.path[0] === 'topic');

  return {
    ok: false,
    code: mentionsTopic ? REALTIME_ERROR_CODES.unknownTopic : REALTIME_ERROR_CODES.invalidMessage,
    reason: z.prettifyError(parsed.error),
  };
};

/** Decodes and validates a raw transport frame in one step. */
export const readInboundFrame = (data: RawSocketData, maxBytes: number): InboundParseResult => {
  const decoded = decodeInboundFrame(data, maxBytes);
  if (!decoded.ok) {
    return { ok: false, code: decoded.code, reason: decoded.reason };
  }
  return parseInboundMessage(decoded.text);
};
