import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { initObservability, shutdown, isInitialized, metrics, flush, trace } from '../src/index';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

function boot() {
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  initObservability({
    serviceName: 'lifecycle',
    traceExporter: new InMemorySpanExporter(),
    metricReader: new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 1_000_000 }),
  });
  return metricExporter;
}

function sum(exporter: InMemoryMetricExporter, name: string): number | undefined {
  let total: number | undefined;
  for (const rm of exporter.getMetrics())
    for (const sm of rm.scopeMetrics)
      for (const m of sm.metrics)
        if (m.descriptor.name === name)
          for (const dp of m.dataPoints as Array<{ value: number }>) total = (total ?? 0) + dp.value;
  return total;
}

test('a metric recorded before init is a no-op, but the same name works after init', async () => {
  metrics.count('early.bird', 1); // no provider yet: silently dropped, must not poison the cache
  const exporter = boot();
  metrics.count('early.bird', 5);
  await flush();
  assert.equal(sum(exporter, 'early.bird'), 5);
  await shutdown();
});

test('shutdown() then initObservability(): the metrics facade re-binds to the new provider', async () => {
  const first = boot();
  metrics.count('jobs.done', 1);
  await flush();
  assert.equal(sum(first, 'jobs.done'), 1);

  await shutdown();
  assert.equal(isInitialized(), false);

  const second = boot();
  metrics.count('jobs.done', 2); // same instrument name: must not hit the dead provider
  await flush();
  assert.equal(sum(second, 'jobs.done'), 2);
  assert.equal(sum(first, 'jobs.done'), 1); // nothing leaked back to the old exporter

  await shutdown();
});

test('a throwing constructor during init leaves the SDK re-initializable', async () => {
  const bad: SpanProcessor = {
    onStart() {
      throw new Error('never reached');
    },
    onEnd() {},
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  // NodeTracerProvider validates spanProcessors eagerly? Not necessarily — use a
  // metric reader whose constructor throws instead, which is deterministic.
  const throwingReader = new Proxy({}, { get: () => { throw new Error('boom in reader'); } });
  assert.throws(
    () => initObservability({ metricReader: throwingReader as any, spanProcessors: [bad] }),
    /boom in reader/,
  );
  assert.equal(isInitialized(), false);

  // A clean init afterwards works.
  const exporter = boot();
  metrics.count('recovered', 1);
  await flush();
  assert.equal(sum(exporter, 'recovered'), 1);
  await shutdown();
});

test('shutdown() unpatches instrumented modules and a re-init re-patches them', async () => {
  const { createRequire } = await import('node:module');
  const { isWrapped } = await import('@opentelemetry/instrumentation');
  // Patching lands on the CommonJS require path (require-in-the-middle); an
  // ESM import of a builtin only goes through the loader hook that
  // register.mjs installs, which this in-process test does not.
  const cjsRequire = createRequire(__filename);
  boot();
  const http = cjsRequire('http') as typeof import('node:http');
  assert.equal(isWrapped(http.request), true, 'patched after first boot');
  await shutdown();
  assert.equal(isWrapped(http.request), false, 'unpatched after shutdown');
  boot();
  assert.equal(isWrapped(http.request), true, 're-patched after re-init');
  assert.ok(trace.getTracerProvider());
  await shutdown();
  assert.equal(isWrapped(http.request), false);
});
