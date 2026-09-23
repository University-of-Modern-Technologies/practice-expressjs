import { describe, expect, it } from '@jest/globals';

import { callProviderBatchSchema } from './provider.js';
import { createStubCallProvider, STUB_CALL_JOURNAL_SIZE } from './stub-provider.js';

describe('stub call provider', () => {
  it('speaks exactly the payload the module requires of a real provider', async () => {
    const batch = await createStubCallProvider().fetchCalls({ limit: STUB_CALL_JOURNAL_SIZE });

    expect(callProviderBatchSchema.safeParse(batch).success).toBe(true);
    expect(batch).toHaveLength(STUB_CALL_JOURNAL_SIZE);
  });

  it('returns the same journal to two independent instances', async () => {
    // Determinism is what makes a repeated sync land entirely in `skipped`:
    // a stub that invented fresh ids would hide a broken idempotency key.
    const first = await createStubCallProvider().fetchCalls({ limit: 5 });
    const second = await createStubCallProvider().fetchCalls({ limit: 5 });

    expect(first).toEqual(second);
    expect(first[0]?.startedAt).toBe('2026-01-02T09:00:00.000Z');
    expect(new Set(first.map((call) => call.externalId)).size).toBe(first.length);
  });

  it('honours the limit and never invents more than its journal holds', async () => {
    const provider = createStubCallProvider();

    await expect(provider.fetchCalls({ limit: 3 })).resolves.toHaveLength(3);
    await expect(provider.fetchCalls({ limit: 0 })).resolves.toHaveLength(0);
    await expect(provider.fetchCalls({ limit: 10_000 })).resolves.toHaveLength(
      STUB_CALL_JOURNAL_SIZE,
    );
  });

  it('records only the conversations that happened', async () => {
    const batch = await createStubCallProvider().fetchCalls({ limit: STUB_CALL_JOURNAL_SIZE });

    for (const call of batch) {
      const answered = call.disposition === 'ANSWERED';
      expect(call.recordingUrl !== undefined).toBe(answered);
      expect(call.durationSeconds > 0).toBe(answered);
    }
    // Both branches have to occur, or the "no recording" path is untested.
    expect(batch.some((call) => call.recordingUrl === undefined)).toBe(true);
    expect(batch.some((call) => call.recordingUrl !== undefined)).toBe(true);
  });
});
