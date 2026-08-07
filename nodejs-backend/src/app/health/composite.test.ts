import { describe, expect, it } from '@jest/globals';

import { createCompositeReadinessCheck } from './composite.js';
import { runReadinessChecks } from './readiness.js';

const never = (): Promise<void> => new Promise<void>(() => undefined);

describe('createCompositeReadinessCheck', () => {
  it('satisfies the same interface as a plain check, invisibly to the caller', async () => {
    const composite = createCompositeReadinessCheck({
      name: 'database',
      checks: [
        { name: 'connection', check: () => Promise.resolve() },
        { name: 'schema', check: () => Promise.resolve() },
      ],
    });

    const [result] = await runReadinessChecks([composite]);

    expect(result).toMatchObject({ name: 'database', status: 'up', critical: true });
  });

  it('fails when a critical sub-check fails', async () => {
    const composite = createCompositeReadinessCheck({
      name: 'database',
      checks: [
        { name: 'connection', check: () => Promise.resolve() },
        { name: 'schema', check: () => Promise.reject(new Error('migration pending')) },
      ],
    });

    const [result] = await runReadinessChecks([composite]);

    expect(result?.status).toBe('down');
    expect(result?.critical).toBe(true);
    // The cause is available for the log line, but never meant for the response.
    expect(String(result?.error)).toContain('schema');
  });

  it('is non-critical only when every sub-check is non-critical', () => {
    const allNonCritical = createCompositeReadinessCheck({
      name: 'optional-group',
      checks: [
        { name: 'a', critical: false, check: () => Promise.resolve() },
        { name: 'b', critical: false, check: () => Promise.resolve() },
      ],
    });
    const mixed = createCompositeReadinessCheck({
      name: 'mixed-group',
      checks: [
        { name: 'a', critical: false, check: () => Promise.resolve() },
        { name: 'b', check: () => Promise.resolve() },
      ],
    });

    expect(allNonCritical.critical).toBe(false);
    expect(mixed.critical).toBe(true);
  });

  it('does not fail when only a non-critical sub-check fails', async () => {
    const composite = createCompositeReadinessCheck({
      name: 'database',
      checks: [
        { name: 'connection', check: () => Promise.resolve() },
        { name: 'search-hint', critical: false, check: () => Promise.reject(new Error('down')) },
      ],
    });

    const [result] = await runReadinessChecks([composite]);

    expect(result?.status).toBe('up');
  });

  it("a hung sub-check times out on its own without blocking a sibling's result", async () => {
    const composite = createCompositeReadinessCheck({
      name: 'database',
      subCheckTimeoutMs: 20,
      checks: [
        { name: 'connection', check: () => Promise.resolve() },
        { name: 'schema', check: never },
      ],
    });

    const startedAt = Date.now();
    const [result] = await runReadinessChecks([composite], 500);

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(result?.status).toBe('down');
  });

  it('a hung composite does not block a sibling top-level check', async () => {
    const stuckComposite = createCompositeReadinessCheck({
      name: 'database',
      subCheckTimeoutMs: 10_000,
      checks: [{ name: 'connection', check: never }],
      timeoutMs: 30,
    });

    const startedAt = Date.now();
    const results = await runReadinessChecks(
      [stuckComposite, { name: 'cache', check: () => Promise.resolve() }],
      500,
    );

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(results.find((entry) => entry.name === 'database')?.status).toBe('timed_out');
    expect(results.find((entry) => entry.name === 'cache')?.status).toBe('up');
  });
});
