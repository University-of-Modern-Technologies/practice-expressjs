import type { CallDisposition } from './types.js';
import type { CallProvider, CallProviderRecord } from './provider.js';

/**
 * The default provider: deterministic, offline, no account, no key, no network.
 *
 * It exists so the module is complete on a fresh checkout — sync answers, the
 * journal fills up, the UI has something to render — without anybody signing a
 * contract with a telephony vendor. It is a *stand-in*, not a switchboard: the
 * journal it hands over is generated from a fixed anchor, so the same run
 * always produces the same records, and a second sync of the same batch is
 * therefore skipped in full rather than duplicated. That determinism is what
 * makes it usable as a fixture as well as a placeholder.
 */

/** The whole universe the stub knows about; `limit` slices into it. */
export const STUB_CALL_JOURNAL_SIZE = 25;

/** Newest call in the generated journal. Fixed, so runs are reproducible. */
const ANCHOR_ISO = '2026-01-02T09:00:00.000Z';

/** Spacing between consecutive generated calls. */
const STEP_MINUTES = 17;

const MINUTE_MS = 60 * 1_000;

const DISPOSITIONS: readonly CallDisposition[] = [
  'ANSWERED',
  'NO_ANSWER',
  'ANSWERED',
  'BUSY',
  'ANSWERED',
  'VOICEMAIL',
  'FAILED',
];

const OFFICE_NUMBER = '+14155550100';

// A caller per record, drawn from a documentation range so nothing in the
// fixture can ever dial a real person.
const callerNumber = (index: number): string => `+1415555${(1_000 + index).toString()}`;

const recordFor = (index: number): CallProviderRecord => {
  const disposition = DISPOSITIONS[index % DISPOSITIONS.length] ?? 'ANSWERED';
  const inbound = index % 2 === 0;
  const startedAt = new Date(Date.parse(ANCHOR_ISO) - index * STEP_MINUTES * MINUTE_MS);
  // Only a conversation has a duration and a recording; the rest are zero, so
  // the "no recording" branch is reachable from the stub alone.
  const answered = disposition === 'ANSWERED';
  const externalId = `stub-call-${(index + 1).toString().padStart(4, '0')}`;

  return {
    externalId,
    direction: inbound ? 'INBOUND' : 'OUTBOUND',
    disposition,
    fromNumber: inbound ? callerNumber(index) : OFFICE_NUMBER,
    toNumber: inbound ? OFFICE_NUMBER : callerNumber(index),
    startedAt: startedAt.toISOString(),
    durationSeconds: answered ? 45 + index * 13 : 0,
    ...(answered ? { recordingUrl: `https://recordings.invalid/${externalId}.mp3` } : {}),
  };
};

export const STUB_CALL_PROVIDER_NAME = 'stub';

export const createStubCallProvider = (): CallProvider => {
  const journal = Array.from({ length: STUB_CALL_JOURNAL_SIZE }, (_value, index) =>
    recordFor(index),
  );

  return {
    name: STUB_CALL_PROVIDER_NAME,
    fetchCalls({ limit }) {
      return Promise.resolve(journal.slice(0, Math.max(0, limit)));
    },
  };
};
