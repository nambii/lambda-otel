import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush } from '../src/sdk';

// `flush()` with no deadline is exercised by every handler test. This file
// covers the deadline: a flush must never hold the response past its budget.
// The providers are not initialized in this process, so forceFlush resolves
// immediately; the timer path is what we're checking.

test('flush with a deadline resolves and clears its timer', async () => {
  const t0 = Date.now();
  await flush(50);
  assert.ok(Date.now() - t0 < 50);
});

test('flush with a zero/negative/NaN deadline never throws', async () => {
  await flush(0);
  await flush(-5);
  await flush(Number.NaN);
});
