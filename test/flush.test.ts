import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, resolveExporterTimeout, DEFAULT_EXPORTER_TIMEOUT_MS } from '../src/sdk';

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

test('exporter timeout: config wins, env defers to the exporter, else the 3s package default', () => {
  assert.equal(resolveExporterTimeout('traces', {}, {}), DEFAULT_EXPORTER_TIMEOUT_MS);
  assert.equal(resolveExporterTimeout('traces', { exporterTimeoutMillis: 1500 }, {}), 1500);
  assert.equal(resolveExporterTimeout('traces', {}, { OTEL_EXPORTER_OTLP_TIMEOUT: '8000' }), undefined);
  assert.equal(resolveExporterTimeout('metrics', {}, { OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: '8000' }), undefined);
  // a per-signal var for a different signal does not affect this one
  assert.equal(resolveExporterTimeout('traces', {}, { OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: '8000' }), DEFAULT_EXPORTER_TIMEOUT_MS);
  // explicit config beats env
  assert.equal(resolveExporterTimeout('logs', { exporterTimeoutMillis: 900 }, { OTEL_EXPORTER_OTLP_TIMEOUT: '8000' }), 900);
});
